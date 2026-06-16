// POST /functions/v1/create-subscription
//
// Called from the public quiz page (anon key, no JWT verification).
// Creates (or reuses) a Stripe Customer + an incomplete Subscription for the
// chosen plan, applying the intro coupon on the first invoice, and returns the
// PaymentIntent client_secret so the funnel's Payment Element can confirm it.
//
// Fulfillment (story creation + chapter 1 + paid flags) happens in the
// stripe-webhook function on `invoice.paid` — NOT here.
//
// Body: { session_id, email, plan }  ->  { client_secret, customer_id, subscription_id }

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { stripe, planConfig, normEmail } from "../_shared/stripe.ts";

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { session_id?: string; email?: string; plan?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const sessionId = (body.session_id ?? "").trim();
  const email = normEmail(body.email ?? "");
  const plan = (body.plan ?? "").trim();
  if (!sessionId || !email || !plan) {
    return jsonResponse({ error: "Missing session_id, email or plan" }, 400);
  }

  const cfg = planConfig(plan);
  if (!cfg) return jsonResponse({ error: "Unknown plan" }, 400);

  const db = adminClient();

  // Reuse an existing incomplete subscription for this session (the Payment
  // Element can re-mount on retries / page revisits).
  const { data: existing } = await db
    .from("quiz_sessions")
    .select("stripe_customer_id, stripe_subscription_id, subscription_status")
    .eq("id", sessionId)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id ?? null;

  if (existing?.stripe_subscription_id && existing.subscription_status === "incomplete") {
    try {
      const sub = await stripe.subscriptions.retrieve(existing.stripe_subscription_id, {
        expand: ["latest_invoice.confirmation_secret"],
      });
      const cs = invoiceClientSecret(sub);
      if (cs && sub.status === "incomplete") {
        return jsonResponse({
          client_secret: cs,
          customer_id: sub.customer,
          subscription_id: sub.id,
        });
      }
    } catch (_) {
      // fall through and create a fresh subscription
    }
  }

  // Find or create the Stripe Customer by email.
  if (!customerId) {
    const found = await stripe.customers.list({ email, limit: 1 });
    customerId = found.data[0]?.id ??
      (await stripe.customers.create({ email, metadata: { session_id: sessionId } })).id;
  }

  let sub;
  try {
    sub = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: cfg.priceId }],
      ...(cfg.couponId ? { discounts: [{ coupon: cfg.couponId }] } : {}),
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret"],
      metadata: { session_id: sessionId, email, plan },
    });
  } catch (e) {
    console.error("subscription create failed:", e);
    return jsonResponse({ error: "Could not start subscription", detail: String(e) }, 502);
  }

  const clientSecret = invoiceClientSecret(sub);
  if (!clientSecret) {
    console.error("no client_secret on latest invoice", sub.id);
    return jsonResponse({ error: "No client secret on invoice" }, 500);
  }

  const { error: upsertErr } = await db.from("quiz_sessions").upsert({
    id: sessionId,
    email,
    plan,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    subscription_status: "incomplete",
  }, { onConflict: "id" });
  if (upsertErr) console.error("quiz_sessions mirror upsert failed:", upsertErr);

  return jsonResponse({
    client_secret: clientSecret,
    customer_id: customerId,
    subscription_id: sub.id,
  });
});

// Pull the first-invoice client secret. Stripe's Basil API (2025-03-31) exposes
// it as latest_invoice.confirmation_secret.client_secret; older shapes used
// latest_invoice.payment_intent.client_secret — support both.
// deno-lint-ignore no-explicit-any
function invoiceClientSecret(sub: any): string | null {
  const inv = sub?.latest_invoice;
  if (!inv || typeof inv === "string") return null;
  return inv.confirmation_secret?.client_secret ?? inv.payment_intent?.client_secret ?? null;
}
