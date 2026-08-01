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
  const { data: profile } = await db
    .from("users")
    .select("id, email, stripe_subscription_id, stripe_customer_id, plan_tier")
    .eq("id", user.id)
    .maybeSingle();
  if (!profile?.stripe_subscription_id) {
    return jsonResponse({ error: "No subscription found for this account" }, 404);
  }

  // Reason is recorded BEFORE any offer is shown, so an abandoned modal still
  // yields the reason — the most valuable output of this whole flow.
  if (action === "record_reason") {
    if (!isValidReason(rawReason)) return jsonResponse({ error: "reason required" }, 400);
    await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "cancel_reason_selected",
      metadata: { reason: rawReason },
    });
    return jsonResponse({ ok: true, rung: nextRung(rawReason, declined) });
  }

  // Optional for the offer-acceptance actions below: used only for the
  // analytics event, so a malformed value is dropped rather than rejected.
  const reason = isValidReason(rawReason) ? rawReason : undefined;

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
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        discounts: [{ coupon: Deno.env.get("STRIPE_COUPON_SAVE50")! }],
      });
      await logOffer(db, profile, "discount", reason);
      return jsonResponse({ ok: true, message: "50% off your next renewal applied." });
    }

    if (action === "downgrade") {
      const sub = await stripe.subscriptions.retrieve(profile.stripe_subscription_id);
      const itemId = sub.items.data[0]?.id;
      if (!itemId) return jsonResponse({ error: "Subscription has no billable item" }, 502);
      await stripe.subscriptions.update(profile.stripe_subscription_id, {
        items: [{ id: itemId, price: Deno.env.get("STRIPE_PRICE_LITE")! }],
        proration_behavior: "none",
      });
      await db.from("users").update({ plan_tier: "lite" }).eq("id", profile.id);
      await logOffer(db, profile, "downgrade", reason);
      return jsonResponse({ ok: true, message: "Switched to the lighter plan." });
    }
  } catch (e) {
    console.error(`retention action ${action} failed:`, e);
    // Fall through to plain cancel client-side — never trap someone leaving.
    return jsonResponse({ error: "Could not apply that offer", detail: String(e) }, 502);
  }

  return jsonResponse({ error: `Unknown action: ${action}` }, 400);
});

// deno-lint-ignore no-explicit-any
async function logOffer(db: any, profile: { id: string; email: string }, rung: string, reason?: string) {
  await db.from("events").insert({
    user_id: profile.id, email: profile.email,
    event_type: "retention_offer_accepted",
    metadata: { rung, reason: reason ?? null },
  });
}
