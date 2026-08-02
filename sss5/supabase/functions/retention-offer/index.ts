// POST /functions/v1/retention-offer
//
// App-side, JWT-authed. Runs the cancellation save-flow: records the stated
// reason, then executes whichever retention rung the user accepts.
//
// Body: { action: "record_reason" | "pause" | "discount" | "downgrade" | "lifetime_checkout",
//         reason?: CancelReason, declined?: Rung[] }
//
// Deliberately does NOT handle plain cancellation — that stays in
// cancel-subscription, so the path that works today cannot be destabilised.
//
// "lifetime_checkout" is added by Task 6 and is intentionally unhandled here
// (falls through to the 400 "Unknown action" response).

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";
import { stripe } from "../_shared/stripe.ts";
import { nextRung, REASONS, type CancelReason, type Rung } from "../_shared/retention.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAUSE_WEEKS = 4;

// An offer action is only honoured if this user recorded a cancel reason
// within this window, and hasn't already accepted an offer in that same
// window — see the eligibility guard below. Named so the policy is visible
// in one place.
const OFFER_WINDOW_MINUTES = 30;

// `reason` comes straight off the HTTP body, so it can be absent, the wrong
// type, or a string that isn't one of the four known reasons. nextRung()
// already no-ops safely on an unrecognised key (falls to "cancel"), but we
// validate at the boundary anyway so malformed input never reaches the
// analytics trail as if it were a real reason.
function isValidReason(r: unknown): r is CancelReason {
  return typeof r === "string" && (REASONS as readonly string[]).includes(r);
}

// `declined` is client-supplied too. It only needs to be an array for
// nextRung()'s `.includes` checks to behave; anything else (missing, wrong
// type, or an array with junk entries) is normalised to a safe empty/filtered
// array rather than trusted as-is.
function sanitizeDeclined(d: unknown): Rung[] {
  if (!Array.isArray(d)) return [];
  return d.filter((x): x is Rung => typeof x === "string") as Rung[];
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonResponse({ error: "Authentication required" }, 401);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "Invalid or expired session — sign in again" }, 401);

  // A JSON body that parses but isn't a plain object (null, an array, a bare
  // number/string) would otherwise throw on `body.action` below — normalise
  // it to {} first so every field read after this is a safe optional lookup.
  let parsed: unknown;
  try { parsed = await req.json(); } catch { parsed = {}; }
  const body: { action?: unknown; reason?: unknown; declined?: unknown } =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  const action = typeof body.action === "string" ? body.action : "";
  const rawReason = body.reason;
  const declined = sanitizeDeclined(body.declined);

  const db = adminClient();
  const { data: profile, error: profileErr } = await db
    .from("users")
    .select("id, email, stripe_subscription_id, stripe_customer_id, plan_tier")
    .eq("id", user.id)
    .maybeSingle();
  if (profileErr) return jsonResponse({ error: "Could not load account" }, 500);
  if (!profile) return jsonResponse({ error: "No account found for this user" }, 404);

  // Reason is recorded BEFORE any offer is shown, so an abandoned modal still
  // yields the reason — the most valuable output of this whole flow. This
  // only needs profile.id/email, so it runs ABOVE the subscription guard
  // below: users who signed up before paying (a known defect — their users
  // row never got stripe_subscription_id linked) are real paying customers
  // whose reason must not be lost to a 404.
  if (action === "record_reason") {
    if (!isValidReason(rawReason)) return jsonResponse({ error: "reason required" }, 400);
    const { error: insertErr } = await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "cancel_reason_selected",
      metadata: { reason: rawReason },
    });
    if (insertErr) {
      console.error("record_reason: failed to insert cancel_reason_selected event:", insertErr);
      return jsonResponse({ error: "Could not record reason" }, 500);
    }
    return jsonResponse({ ok: true, rung: nextRung(rawReason, declined) });
  }

  // Everything below actually changes the subscription, so it genuinely
  // needs a linked Stripe subscription.
  if (!profile.stripe_subscription_id) {
    return jsonResponse({ error: "No subscription found for this account" }, 404);
  }

  // Optional for the offer-acceptance actions below: used only for the
  // analytics event, so a malformed value is dropped rather than rejected.
  const reason = isValidReason(rawReason) ? rawReason : undefined;

  // Eligibility guard for the three offer actions: without this, any
  // authenticated subscriber could POST an offer action on a loop. `pause`
  // resets resumes_at every call (indefinite free access via
  // pause_collection: void), and `discount` is otherwise re-appliable every
  // cycle. Scope, as decided by the product owner: an offer is honoured only
  // if this user recorded a reason within the window AND has not already
  // accepted an offer within that same window. Verifying the requested rung
  // matches what nextRung would have offered is deliberately NOT done here —
  // all offers are reachable through the UI by any subscriber anyway, and
  // mirroring the full ladder risks wedging a legitimate user on a
  // back-button or double-submit.
  if (action === "pause" || action === "discount" || action === "downgrade") {
    const windowStartIso = new Date(Date.now() - OFFER_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { data: recentEvents, error: recentErr } = await db
      .from("events")
      .select("event_type")
      .eq("user_id", profile.id)
      .gte("created_at", windowStartIso)
      .in("event_type", ["cancel_reason_selected", "retention_offer_accepted"]);
    if (recentErr) {
      console.error("retention-offer: eligibility check failed:", recentErr);
      return jsonResponse({ error: "Could not verify offer eligibility" }, 500);
    }
    const events = (recentEvents ?? []) as Array<{ event_type: string }>;
    const hasRecentReason = events.some((e) => e.event_type === "cancel_reason_selected");
    const hasRecentAcceptedOffer = events.some((e) => e.event_type === "retention_offer_accepted");
    if (!hasRecentReason || hasRecentAcceptedOffer) {
      return jsonResponse({ error: "This offer is no longer available" }, 409);
    }
  }

  try {
    if (action === "pause") {
      const resumesAt = Math.floor(Date.now() / 1000) + PAUSE_WEEKS * 7 * 24 * 3600;
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        pause_collection: { behavior: "void", resumes_at: resumesAt },
      });
      await logOffer(db, profile, "pause", reason);
      return jsonResponse({ ok: true, message: `Paused for ${PAUSE_WEEKS} weeks.` });
    }

    if (action === "discount") {
      // A missing secret is not a compile-time-safe `!` away from a runtime
      // guarantee: `Deno.env.get(...)!` is erased at runtime, so an unset
      // var is `undefined` at the call site. Stripe's request serializer
      // (qs) silently DROPS keys whose value is undefined rather than
      // erroring — `discounts: [{ coupon: undefined }]` serializes to
      // nothing, Stripe returns 200 having done nothing, and the user would
      // be told a discount was applied when it wasn't. Read it into a const
      // and fail loudly (502, pre-mutation) instead. Since Task 5 deliberately
      // ships before the human creates the Stripe coupon and sets this
      // secret, unset is the EXPECTED state on first deploy.
      const couponId = Deno.env.get("STRIPE_COUPON_SAVE50");
      if (!couponId) {
        console.error("retention-offer: STRIPE_COUPON_SAVE50 is not set — refusing to apply discount");
        return jsonResponse({ error: "Could not apply that offer" }, 502);
      }

      // Set semantics, not append: `discounts: [...]` REPLACES whatever
      // discount is already on the subscription. This codebase deliberately
      // keeps 100%-off coupon holders as test/free accounts (see
      // slack-stats/index.ts). Overwriting that with 50%-off would start
      // charging a previously-free account. Check first; never clobber.
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      if ((sub.discounts ?? []).length > 0) {
        return jsonResponse({ error: "This offer is no longer available" }, 409);
      }

      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        discounts: [{ coupon: couponId }],
      });
      await logOffer(db, profile, "discount", reason);
      return jsonResponse({ ok: true, message: "50% off your next renewal applied." });
    }

    if (action === "downgrade") {
      // Same missing-secret hazard as STRIPE_COUPON_SAVE50 above, but worse
      // here: `items: [{ id: itemId, price: undefined }]` drops the `price`
      // key, so Stripe's update is a no-op on price, execution would
      // continue past it, and the plan_tier write below would still land —
      // dropping the user to the Lite story quota while still being billed
      // full price, having been talked out of cancelling by a downgrade that
      // never happened. Fail loudly before touching Stripe.
      const litePriceId = Deno.env.get("STRIPE_PRICE_LITE");
      if (!litePriceId) {
        console.error("retention-offer: STRIPE_PRICE_LITE is not set — refusing to apply downgrade");
        return jsonResponse({ error: "Could not apply that offer" }, 502);
      }

      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      const itemId = sub.items.data[0]?.id;
      if (!itemId) return jsonResponse({ error: "Subscription has no billable item" }, 502);
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        items: [{ id: itemId, price: litePriceId }],
        proration_behavior: "none",
      });

      // The Stripe mutation above has already landed — everything past this
      // point is bookkeeping. A failure here must not be reported as an
      // offer failure (which would send the frontend to plain cancel,
      // cancelling a subscription that was just successfully downgraded), so
      // it's logged rather than thrown/returned as an error.
      const { error: planTierErr } = await db.from("users").update({ plan_tier: "lite" }).eq("id", profile.id);
      if (planTierErr) {
        console.error(`retention-offer: plan_tier update to 'lite' failed for user ${profile.id} after Stripe price change succeeded:`, planTierErr);
      }
      await logOffer(db, profile, "downgrade", reason);
      return jsonResponse({ ok: true, message: "Switched to the lighter plan." });
    }
  } catch (e) {
    console.error(`retention action ${action} failed:`, e);
    // Fall through to plain cancel client-side — never trap someone leaving.
    // No `detail` in the response: Stripe error messages can name coupon and
    // price ids; the full error is logged server-side only.
    return jsonResponse({ error: "Could not apply that offer" }, 502);
  }

  return jsonResponse({ error: `Unknown action: ${action}` }, 400);
});

// Post-mutation bookkeeping only — called after the Stripe change has
// already succeeded. Never throws and never surfaces its failure to the
// caller: a broken analytics write must not turn a successful pause/discount
// into a reported failure (which the frontend treats as "go to plain
// cancel"). Failures are logged for ops to notice separately.
// deno-lint-ignore no-explicit-any
async function logOffer(db: any, profile: { id: string; email: string }, rung: string, reason?: string) {
  try {
    const { error } = await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "retention_offer_accepted",
      metadata: { rung, reason: reason ?? null },
    });
    if (error) {
      console.error(`logOffer: failed to record retention_offer_accepted (rung=${rung}) for user ${profile.id}:`, error);
    }
  } catch (e) {
    console.error(`logOffer: threw while recording retention_offer_accepted (rung=${rung}) for user ${profile.id}:`, e);
  }
}
