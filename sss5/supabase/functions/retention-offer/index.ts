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
// "lifetime_checkout" (Task 6) creates a one-time $79 Checkout Session and
// returns its URL; it does not itself charge or fulfil anything — Task 7's
// webhook does that once the customer completes payment.

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
  // Deliberately does NOT select plan_tier: nothing here reads it, and selecting
  // it would make every request — including `record_reason`, which must survive
  // anything — depend on the retention migration having already been applied. If
  // the functions are deployed before `supabase db push`, PostgREST errors on the
  // unknown column and reason capture (the most valuable output of this flow)
  // dies with it. Keep this select to columns that predate the feature.
  const { data: profile, error: profileErr } = await db
    .from("users")
    .select("id, email, stripe_subscription_id, stripe_customer_id")
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

    // ONE CANCELLATION MUST PRODUCE ONE ROW.
    //
    // The frontend calls this endpoint again on every decline and on every
    // "show me another option", so a single `too_expensive` walk down the
    // ladder used to write three identical rows and `broken` two. That
    // over-counts NON-UNIFORMLY — most for the users who went deepest — and
    // this table is the churn-reason evidence the repricing decision rests on.
    //
    // Deduped on (user, same reason, inside OFFER_WINDOW_MINUTES) — the same
    // window the eligibility guard below uses, so skipping the insert always
    // leaves a row that guard can still see. A DIFFERENT reason inside the
    // window still inserts: that is a genuine second data point (the user
    // changed their stated reason), not a repeat of the same one.
    //
    // FAIL OPEN. If this lookup errors we insert anyway. A duplicate row is a
    // counting nuisance; zero rows would make the user ineligible for every
    // offer AND lose their reason entirely, which is strictly worse.
    //
    // Residual, accepted: a user who idles ~29 minutes mid-flow and then
    // declines can have their only row age out of the guard's window shortly
    // after this call skipped the refresh, yielding a 409 on the next offer.
    // The frontend treats 409 as "that offer is unavailable" (never as
    // cancel), and the reason is already captured, so the flow degrades safely.
    const dedupWindowIso = new Date(Date.now() - OFFER_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { data: priorReasons, error: priorErr } = await db
      .from("events")
      .select("metadata")
      .eq("user_id", profile.id)
      .eq("event_type", "cancel_reason_selected")
      .gte("created_at", dedupWindowIso);
    if (priorErr) {
      console.error("record_reason: duplicate check failed, inserting anyway:", priorErr);
    }
    const alreadyRecorded = !priorErr && (priorReasons ?? []).some(
      (e: { metadata?: { reason?: unknown } | null }) => e?.metadata?.reason === rawReason,
    );

    if (!alreadyRecorded) {
      const { error: insertErr } = await db.from("events").insert({
        user_id: profile.id, email: profile.email,
        event_type: "cancel_reason_selected",
        metadata: { reason: rawReason },
      });
      if (insertErr) {
        console.error("record_reason: failed to insert cancel_reason_selected event:", insertErr);
        return jsonResponse({ error: "Could not record reason" }, 500);
      }
    }

    // DON'T OFFER A RUNG THE ACCEPT-TIME GUARDS WILL REFUSE.
    //
    // nextRung() knows only the reason and what was declined, so a user who
    // already holds a 50%-off coupon was being shown "Stay for half price"
    // again — and got a 409 the moment they clicked it. A dead-end tease, and
    // it also fires a retention_offer_shown impression that can never convert,
    // skewing the per-rung deflection rate this feature exists to measure.
    //
    // Feeding already-applied rungs in as pre-declined reuses the existing
    // ladder mechanics instead of adding a parallel notion of availability:
    // the ladder simply advances to the next thing they CAN take, and falls
    // through to "cancel" when nothing is left.
    //
    // BEST EFFORT. Every lookup here is allowed to fail silently — if it does,
    // we offer the full ladder and the accept-time state checks still refuse
    // safely, which is exactly today's behaviour. The reason was already
    // recorded above, so nothing here can cost us that.
    const unavailable: Rung[] = [];
    if (profile.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
        if ((sub.discounts ?? []).length > 0) unavailable.push("discount");
        if (sub.pause_collection) unavailable.push("pause");
        const litePriceId = Deno.env.get("STRIPE_PRICE_LITE");
        if (litePriceId && (sub.items?.data ?? []).some((i) => i.price?.id === litePriceId)) {
          unavailable.push("downgrade");
        }
      } catch (e) {
        console.error("record_reason: could not read subscription state, offering full ladder:", e);
      }

      // A lifetime holder can take nothing — every rung either charges them
      // again or downgrades what they already own outright. Left as a soft
      // lookup so this never re-couples reason capture to the migration.
      const { data: lt } = await db
        .from("users").select("lifetime_at").eq("id", profile.id).maybeSingle();
      if (lt?.lifetime_at) unavailable.push("discount", "lifetime", "pause", "downgrade");
    }

    // Unchanged either way: the response contract does not depend on whether a
    // row was written. Only the write is deduped.
    return jsonResponse({ ok: true, rung: nextRung(rawReason, [...declined, ...unavailable]) });
  }

  // Everything below actually changes the subscription, so it genuinely
  // needs a linked Stripe subscription.
  if (!profile.stripe_subscription_id) {
    return jsonResponse({ error: "No subscription found for this account" }, 404);
  }

  // Optional for the offer-acceptance actions below: used only for the
  // analytics event, so a malformed value is dropped rather than rejected.
  const reason = isValidReason(rawReason) ? rawReason : undefined;

  // Eligibility guard for the four offer actions: without this, any
  // authenticated subscriber could POST an offer action on a loop. `pause`
  // resets resumes_at every call (indefinite free access via
  // pause_collection: void), and `discount` is otherwise re-appliable every
  // cycle. All four actions require a cancel reason recorded within the
  // window — that half is what keeps `lifetime_checkout` from being a
  // standing purchase link any subscriber can hit directly; the product
  // intent is that $79 lifetime is offered only behind a stated price
  // objection.
  //
  // The SECOND half — no offer already accepted within the window — is the
  // anti-stacking rule, and it applies only to pause/discount/downgrade.
  // (Separately: verifying the requested rung matches what nextRung would
  // have offered is deliberately NOT done here — all offers are reachable
  // through the UI by any subscriber anyway, and mirroring the full ladder
  // risks wedging a legitimate user on a back-button or double-submit.)
  //
  // `lifetime_checkout` is deliberately EXEMPT from the anti-stacking half.
  // Creating a Checkout Session mutates nothing and charges nobody by
  // itself (fulfilment happens later, in the webhook, only if the customer
  // completes payment), so it cannot participate in "stacking" in the first
  // place — and a user who just accepted pause/discount/downgrade and then
  // decides within the same window that they'd rather pay $79 outright is
  // handing over more revenue, not exploiting the ladder. Blocking that with
  // a rule meant to stop stacking would enforce the guard past its purpose.
  // (`lifetime_checkout_started` is intentionally not one of the event types
  // counted below, for the same reason it doesn't count as "accepted": a
  // user who abandons Stripe's hosted page and comes back must get a fresh
  // session, not a 409.)
  if (action === "pause" || action === "discount" || action === "downgrade" || action === "lifetime_checkout") {
    // LIFETIME HOLDERS GET NO OFFERS — all four, not just lifetime_checkout.
    //
    // A lifetime holder can only reach this flow in one state: the grant
    // landed but stripe.subscriptions.cancel() failed in the webhook (which
    // deliberately tolerates that failure rather than throwing after the
    // grant), leaving them holding lifetime AND a live billing subscription.
    // Settings now keeps the cancel button visible in exactly that state, so
    // the flow behind it is reachable where it previously was not.
    //
    // Every rung is wrong for them, each for its own reason:
    //   lifetime_checkout — charges $79 for a perpetual licence they already
    //     own. A straight money defect.
    //   downgrade — the worst of the four. It writes plan_tier='lite', which
    //     cuts a lifetime holder from 3 stories/month to 1 while still
    //     billing them $9.99 for a subscription they do not need. It degrades
    //     an entitlement they have already paid for in full.
    //   discount — halves a charge that should be zero, and books a
    //     "save" against a subscription that was never going to be kept.
    //   pause — voids collection for four weeks and then resumes billing,
    //     so it hides the problem and re-bills them a month later while the
    //     user believes it is dealt with.
    // Plain cancellation is the only coherent outcome, and it stays fully
    // available: a 409 lands the frontend on the "That offer isn't available"
    // screen, which shows this message and offers "Cancel my subscription"
    // alongside "Show me another option" and "keep my subscription". Nothing
    // here traps them, and `record_reason` is deliberately NOT gated, so
    // their stated reason is still captured.
    //
    // Queried SEPARATELY rather than added to the profile select above, on
    // purpose. That select was just stripped back to pre-feature columns so
    // that `record_reason` — the most valuable output of this flow — cannot
    // be killed by deploying the functions before the migration. `lifetime_at`
    // ships in that same migration, so putting it back there would re-create
    // exactly the coupling that removal was for. The offer actions may depend
    // on the migration (downgrade already writes plan_tier, and the rungs are
    // inert without it); reason capture may not.
    const { data: entitlement, error: entitlementErr } = await db
      .from("users").select("lifetime_at").eq("id", profile.id).maybeSingle();
    if (entitlementErr) {
      // Fail CLOSED, same as the eligibility check below: we cannot rule out
      // that this is a lifetime holder, and the cost of guessing wrong is
      // charging them again. A 500 on the accept path shows "That didn't go
      // through" — it never cancels on the user's behalf.
      console.error("retention-offer: lifetime lookup failed:", entitlementErr);
      return jsonResponse({ error: "Could not verify offer eligibility" }, 500);
    }
    if (entitlement?.lifetime_at) {
      return jsonResponse({
        error: "You already have lifetime access, so there's nothing here to add to it. " +
          "This leftover subscription can be cancelled without affecting it.",
      }, 409);
    }

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
    const ineligible = action === "lifetime_checkout"
      ? !hasRecentReason
      : (!hasRecentReason || hasRecentAcceptedOffer);
    if (ineligible) {
      return jsonResponse({ error: "This offer is no longer available" }, 409);
    }
  }

  try {
    if (action === "pause") {
      // Same STATE-check need as discount below, for the same reason: the
      // TEMPORAL eligibility guard above rate-limits this to once per
      // OFFER_WINDOW_MINUTES but does not close the hole — looping
      // record_reason -> pause every window resets resumes_at to "now +
      // PAUSE_WEEKS" each time, and behavior: "void" keeps the subscription
      // active with current_period_end still advancing. That's indefinite
      // free access, just slower. Check first; refuse to re-arm a pause
      // that's already in effect.
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      if (sub.pause_collection) {
        return jsonResponse({ error: "This offer is no longer available" }, 409);
      }

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
      //
      // ⚠ plan_tier IS A ONE-WAY DOOR. This is the only writer of 'lite', and
      // the only writer of 'standard' is the lifetime grant in
      // stripe-webhook. Nothing resets it: not invoice.paid, not
      // customer.subscription.updated, not a resubscribe. So if this user is
      // ever moved back onto a standard price — by resubscribing, or by you
      // editing their price in the Stripe dashboard after a support email —
      // they keep plan_tier='lite' and silently get 1 story/month at full
      // price, with the UI confidently agreeing with the wrong number.
      // REVERSING A DOWNGRADE MEANS UPDATING THIS COLUMN TOO. Runbook and SQL:
      // docs/superpowers/specs/2026-08-01-retention-save-flow-design.md,
      // "Operational notes".
      const { error: planTierErr } = await db.from("users").update({ plan_tier: "lite" }).eq("id", profile.id);
      if (planTierErr) {
        console.error(`retention-offer: plan_tier update to 'lite' failed for user ${profile.id} after Stripe price change succeeded:`, planTierErr);
      }
      await logOffer(db, profile, "downgrade", reason);
      return jsonResponse({ ok: true, message: "Switched to the lighter plan." });
    }

    if (action === "lifetime_checkout") {
      if (!profile.stripe_customer_id) {
        return jsonResponse({ error: "No Stripe customer on this account" }, 404);
      }

      // Same missing-secret hazard as STRIPE_COUPON_SAVE50 / STRIPE_PRICE_LITE
      // above: `Deno.env.get(...)!` is erased at runtime, and Stripe's
      // request serializer (qs) silently drops keys whose value is
      // undefined — a missing price would build a checkout session with no
      // line item, and a missing APP_URL would send a paying customer to a
      // redirect of "undefined/settings.html...". Read both into consts and
      // fail before calling Stripe. Since Task 6 ships before the human
      // creates the Stripe price and sets these secrets, unset is the
      // EXPECTED state on first deploy.
      const lifetimePriceId = Deno.env.get("STRIPE_PRICE_LIFETIME");
      const appUrl = Deno.env.get("APP_URL");
      if (!lifetimePriceId || !appUrl) {
        console.error("retention-offer: STRIPE_PRICE_LIFETIME or APP_URL is not set — refusing to start lifetime checkout");
        return jsonResponse({ error: "Could not start checkout" }, 502);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer: profile.stripe_customer_id,
        line_items: [{ price: lifetimePriceId, quantity: 1 }],
        success_url: `${appUrl}/settings.html?lifetime=success`,
        cancel_url: `${appUrl}/settings.html?lifetime=cancelled`,
        // The Stripe account is shared with another product. These two keys
        // are how the webhook recognises this payment as ours and knows who
        // to credit — a one-time payment has no subscription for ours() to
        // check.
        metadata: { app: "sss", supabase_user_id: profile.id },
      });

      // The Checkout Session above has already been created — everything
      // past this point is bookkeeping. supabase-js resolves { error }, it
      // never throws, so this must be destructured and checked explicitly;
      // a failure here must not be reported as a checkout failure (which
      // would send the frontend to plain cancel on a session the user can
      // still complete), so it's logged rather than returned as an error.
      const { error: startedErr } = await db.from("events").insert({
        user_id: profile.id, email: profile.email,
        event_type: "lifetime_checkout_started",
        metadata: { reason: reason ?? null, checkout_session_id: session.id },
      });
      if (startedErr) {
        console.error(`retention-offer: failed to insert lifetime_checkout_started event for user ${profile.id}:`, startedErr);
      }
      return jsonResponse({ ok: true, checkout_url: session.url });
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
