// POST /functions/v1/create-story-pack-checkout
//
// Called from sss-app (logged-in user) when they tap "Buy pack →".
// Creates a Stripe Checkout Session for the one-time $4.99 story-pack price.
// Fulfillment happens in stripe-webhook on `checkout.session.completed`
// (mode=payment, metadata.type=story_pack_3) — NOT here.
//
// Auth: requires user JWT (Bearer). We use it to identify the user and to
// prevent random anons from creating sessions on someone else's behalf.
//
// Body: { return_path?: string }   // optional path to send them back to on success
// Response: { url: string, session_id: string }

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { stripeFor, parseAccount, priceFor, normEmail } from "../_shared/stripe.ts";
import { adminClient } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The one-time price for "3 extra stories" now lives per-account in
// STRIPE_PRICE_STORY_PACK / STRIPE_ASTRONAUT_PRICE_STORY_PACK — it can no
// longer be a single constant, since leadoni and astronaut each have their own
// price object for the same $4.99 product.
const STORY_PACK_CREDITS = 3;   // must match the count granted in stripe-webhook

const APP_ORIGIN = "https://app.stuffsosweet.com";

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  // Verify user JWT
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }
  const userJwt = authHeader.slice(7);
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) {
    return jsonResponse({ error: "Invalid or expired session — sign in again" }, 401);
  }

  // Optional return path (e.g. /stories.html or /quiz2.html) — sanitized to
  // same-origin paths only to prevent open-redirects.
  let returnPath = "/stories.html";
  try {
    const body = await req.json();
    const rp = String(body?.return_path ?? "").trim();
    if (rp.startsWith("/") && !rp.startsWith("//")) returnPath = rp;
  } catch { /* body is optional */ }

  // Pull the user's Stripe customer id if we have one — attaching to an
  // existing customer keeps their payment methods + purchase history unified.
  // If missing, Checkout will create one and we'll capture it in the webhook.
  const db = adminClient();
  const { data: profile } = await db.from("users")
    .select("email, stripe_customer_id, display_name, stripe_account")
    .eq("id", user.id).maybeSingle();

  const email = normEmail(profile?.email ?? user.email ?? "");
  const existingCustomerId = profile?.stripe_customer_id || null;

  // The customer id we may attach below only exists on this user's own account.
  const account = parseAccount(profile?.stripe_account);
  const stripe = stripeFor(account);
  const storyPackPrice = priceFor(account, "STORY_PACK");
  if (!storyPackPrice) {
    console.error("story pack price not configured for account", account);
    return jsonResponse({ error: "Story packs are unavailable right now" }, 503);
  }

  // Build the checkout session. mode=payment (one-time), not subscription.
  const successUrl = `${APP_ORIGIN}${returnPath}${returnPath.includes("?") ? "&" : "?"}pack=ok&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${APP_ORIGIN}${returnPath}${returnPath.includes("?") ? "&" : "?"}pack=cancel`;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: storyPackPrice, quantity: 1 }],
      // If we know the customer, attach; otherwise pre-fill email and let
      // Stripe create a customer we can capture in the webhook.
      ...(existingCustomerId
        ? { customer: existingCustomerId }
        : { customer_email: email || undefined, customer_creation: "always" }),
      // Metadata is the source of truth for the webhook:
      //   type=story_pack_3 identifies the branch to run
      //   user_id is the sss-app user to credit
      //   credits is the amount to add (double-check in webhook against
      //     type constant, so a tampered metadata can't grant more)
      metadata: {
        type: "story_pack_3",
        user_id: user.id,
        credits: String(STORY_PACK_CREDITS),
        stripe_account: account,
      },
      // Payment_intent_data.metadata is duplicated so it's queryable from a PI too
      payment_intent_data: {
        metadata: {
          type: "story_pack_3",
          user_id: user.id,
          credits: String(STORY_PACK_CREDITS),
        },
        description: "Stuff So Sweet — 3-story top-up pack",
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Small readability polish in the Stripe-hosted page
      submit_type: "pay",
      allow_promotion_codes: false,
    });

    // Log the intent (before payment) so we can debug abandoned checkouts.
    await db.from("events").insert({
      user_id: user.id,
      email: email || null,
      event_type: "story_pack_checkout_started",
      metadata: {
        checkout_session_id: session.id,
        return_path: returnPath,
      },
    }).select("id").maybeSingle().then(() => {}).catch(() => {});

    return jsonResponse({ url: session.url, session_id: session.id });
  } catch (e) {
    console.error("[create-story-pack-checkout] Stripe error:", e);
    return jsonResponse({
      error: "Couldn't start checkout — try again in a moment.",
      detail: (e as Error)?.message,
    }, 500);
  }
});
