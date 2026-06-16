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

  let body: {
    session_id?: string; email?: string; plan?: string; promo?: string;
    event_id?: string; fbc?: string; fbp?: string; event_source_url?: string; user_agent?: string;
  };
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

  // Meta CAPI signals — captured here (a direct browser call) so the IP/UA are
  // the real client's, then carried via subscription metadata to the webhook.
  const metaEventId = (body.event_id ?? "").toString().slice(0, 64);
  const clientIp = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const userAgent = (req.headers.get("user-agent") ?? body.user_agent ?? "").toString().slice(0, 350);
  const metaMeta: Record<string, string> = {};
  if (metaEventId) metaMeta.meta_event_id = metaEventId;
  if (body.fbc) metaMeta.meta_fbc = String(body.fbc).slice(0, 255);
  if (body.fbp) metaMeta.meta_fbp = String(body.fbp).slice(0, 255);
  if (clientIp) metaMeta.meta_ip = clientIp;
  if (userAgent) metaMeta.meta_ua = userAgent;
  if (body.event_source_url) metaMeta.meta_src = String(body.event_source_url).slice(0, 300);

  const cfg = planConfig(plan);
  if (!cfg) return jsonResponse({ error: "Unknown plan" }, 400);

  // Internal testing: a secret promo (passed as ?promo=) charges $0.50 via a
  // dedicated test price, for ANY plan. Validated server-side against an env
  // secret, so the code never appears in client JS. Inert unless both
  // STRIPE_TEST_PROMO and STRIPE_PRICE_TEST are set.
  const promo = (body.promo ?? "").toString().trim();
  const testPromo = Deno.env.get("STRIPE_TEST_PROMO") ?? "";
  const testPriceId = Deno.env.get("STRIPE_PRICE_TEST") ?? "";
  const useTestPrice = !!testPromo && !!testPriceId && promo === testPromo;
  const effectivePriceId = useTestPrice ? testPriceId : cfg.priceId;
  const effectiveCouponId = useTestPrice ? undefined : cfg.couponId;

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
          meta_event_id: sub.metadata?.meta_event_id ?? metaEventId,
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
      items: [{ price: effectivePriceId }],
      ...(effectiveCouponId ? { discounts: [{ coupon: effectiveCouponId }] } : {}),
      payment_behavior: "default_incomplete",
      payment_settings: { save_default_payment_method: "on_subscription" },
      expand: ["latest_invoice.confirmation_secret"],
      metadata: { session_id: sessionId, email, plan, ...metaMeta },
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
    meta_event_id: metaEventId,
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
