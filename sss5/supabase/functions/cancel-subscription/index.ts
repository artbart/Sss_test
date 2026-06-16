// POST /functions/v1/cancel-subscription
//
// App-side, JWT-authed. Lets a signed-in user cancel (at period end) or
// reactivate their subscription. Access is paid-through, so cancelling keeps
// the app usable until current_period_end — matching the gating model.
//
// Body: { action?: "cancel" | "reactivate" }   (default: cancel)
// Returns: { ok, cancel_at_period_end, current_period_end }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";
import { stripe } from "../_shared/stripe.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  let body: { action?: string };
  try { body = await req.json(); } catch { body = {}; }
  const reactivate = body.action === "reactivate";

  const db = adminClient();
  const { data: profile, error: profErr } = await db
    .from("users")
    .select("stripe_subscription_id, subscription_status")
    .eq("id", user.id)
    .maybeSingle();
  if (profErr || !profile?.stripe_subscription_id) {
    return jsonResponse({ error: "No subscription found for this account" }, 404);
  }

  let sub;
  try {
    sub = await stripe.subscriptions.update(profile.stripe_subscription_id, {
      cancel_at_period_end: !reactivate,
    });
  } catch (e) {
    console.error("subscription update failed:", e);
    return jsonResponse({ error: "Could not update subscription", detail: String(e) }, 502);
  }

  // Optimistic mirror for instant UI; the customer.subscription.updated webhook
  // also syncs this (and is the source of truth).
  await db.from("users").update({ cancel_at_period_end: !reactivate }).eq("id", user.id);

  // deno-lint-ignore no-explicit-any
  const item = (sub as any).items?.data?.[0];
  // deno-lint-ignore no-explicit-any
  const cpeUnix = item?.current_period_end ?? (sub as any).current_period_end;
  const currentPeriodEnd = cpeUnix ? new Date(cpeUnix * 1000).toISOString() : null;

  await db.from("events").insert({
    user_id: user.id,
    email: user.email,
    event_type: reactivate ? "subscription_reactivated" : "subscription_cancel_requested",
    metadata: { current_period_end: currentPeriodEnd },
  });

  return jsonResponse({ ok: true, cancel_at_period_end: !reactivate, current_period_end: currentPeriodEnd });
});
