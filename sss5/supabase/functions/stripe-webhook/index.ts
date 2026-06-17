// POST /functions/v1/stripe-webhook
//
// Stripe -> us. Secured by signature verification (NOT JWT). This is the source
// of truth for fulfillment: it updates subscription state on quiz_sessions +
// users, and on the FIRST invoice it creates the story row and triggers
// chapter-1 generation.
//
// SHARED ACCOUNT: this Stripe account also hosts other products (e.g. PhaseMap),
// and Stripe delivers account-wide events to every endpoint. We therefore
// process ONLY Stuff So Sweet subscriptions — identified by metadata.session_id,
// which create-subscription always sets. Everything else is ack'd and ignored.
//
// Events: invoice.paid, invoice.payment_failed,
//         customer.subscription.updated, customer.subscription.deleted

import { adminClient } from "../_shared/db.ts";
import { stripe, cryptoProvider } from "../_shared/stripe.ts";
import { sendCapiPurchase } from "../_shared/meta.ts";
import type Stripe from "npm:stripe@17";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const ACK = () => new Response("ok", { status: 200 });

function isoOrNull(unixSeconds: number | null | undefined): string | null {
  return unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;
}

// Basil API (2025-03-31): current_period_* moved off the Subscription onto its
// items. Fall back to the (legacy) top-level fields for older API versions.
// deno-lint-ignore no-explicit-any
function subPeriod(sub: any): { start: string | null; end: string | null } {
  const item = sub?.items?.data?.[0];
  return {
    start: isoOrNull(item?.current_period_start ?? sub?.current_period_start),
    end: isoOrNull(item?.current_period_end ?? sub?.current_period_end),
  };
}

// Basil API: invoice.subscription was removed; the ref now lives at
// invoice.parent.subscription_details.subscription.
// deno-lint-ignore no-explicit-any
function invoiceSubId(inv: any): string | null {
  return inv?.parent?.subscription_details?.subscription ?? inv?.subscription ?? null;
}

// Ownership marker: our subscriptions always carry metadata.session_id.
// deno-lint-ignore no-explicit-any
function ours(sub: any): boolean {
  return !!sub?.metadata?.session_id;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, WEBHOOK_SECRET, undefined, cryptoProvider);
  } catch (e) {
    console.error("signature verification failed:", e);
    return new Response("Bad signature", { status: 400 });
  }

  const db = adminClient();

  try {
    // Resolve the subscription for this event and confirm it's ours. Non-SSS
    // events (e.g. PhaseMap, which shares this account) are ack'd and ignored
    // BEFORE any idempotency record or DB write.
    let sub: Stripe.Subscription | null = null;
    // deno-lint-ignore no-explicit-any
    let inv: any = null;

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      inv = event.data.object;
      const subId = invoiceSubId(inv);
      if (!subId) return ACK(); // not a subscription invoice
      sub = await stripe.subscriptions.retrieve(subId);
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      sub = event.data.object as Stripe.Subscription;
    } else {
      return ACK(); // event type we don't handle
    }

    if (!ours(sub)) return ACK(); // not a Stuff So Sweet subscription

    // Idempotency (only for our events): first writer wins.
    const { error: dupErr } = await db.from("stripe_events").insert({ id: event.id, type: event.type });
    if (dupErr) return new Response("ok (dup)", { status: 200 });

    const meta = sub.metadata ?? {};
    const sessionId = meta.session_id ?? null;
    const period = subPeriod(sub);
    const subFields = {
      subscription_status: event.type === "customer.subscription.deleted" ? "canceled" : sub.status,
      current_period_start: period.start,
      current_period_end: period.end,
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
    };

    if (event.type === "invoice.paid") {
      const email = (meta.email ?? inv.customer_email ?? "").toLowerCase();

      if (sessionId) {
        await db.from("quiz_sessions").update({
          ...subFields,
          paid: true,
          payment_at: new Date().toISOString(),
          status: "paid",
        }).eq("id", sessionId);
      }
      await db.from("users").update(subFields).eq("stripe_customer_id", sub.customer as string);

      // First invoice -> create story + trigger chapter 1 (once).
      if (inv.billing_reason === "subscription_create" && sessionId && email) {
        const { data: already } = await db
          .from("stories").select("id").eq("session_id", sessionId).limit(1).maybeSingle();
        if (!already) {
          const { data: story, error: stErr } = await db.from("stories")
            .insert({ session_id: sessionId, lead_email: email, status: "pending" })
            .select("id").single();
          if (stErr || !story) {
            console.error("story insert failed:", stErr);
          } else {
            // Audit trail: record that fulfillment fired BEFORE trying to trigger
            // chapter generation. So if the trigger fails again for any reason, we
            // can still see in the events table that we got this far.
            await db.from("events").insert({
              email,
              session_id: sessionId,
              story_id: story.id,
              event_type: "payment_fulfilled",
              metadata: {
                stripe_event_id: event.id,
                amount_paid_cents: inv.amount_paid ?? null,
                billing_reason: inv.billing_reason ?? null,
              },
            }).then(({ error: evErr }) => {
              if (evErr) console.error("events payment_fulfilled insert failed:", evErr);
            });

            // Trigger chapter 1 generation via the edge function HTTP endpoint.
            //
            // CRITICAL: Supabase's API gateway requires BOTH the `apikey` header
            // (for routing) AND the `Authorization` header (for the function's
            // own JWT verification, even though generate-chapter has
            // verify_jwt:false — the gateway still inspects it). Earlier this
            // call only set Authorization; the gateway rejected the request with
            // 401 BEFORE generate-chapter saw it, and `fetch().catch()` does NOT
            // fire on non-2xx HTTP responses — only on network errors. The
            // failure was silent. Every paying user got stuck at status=pending.
            // Discovered 2026-06-17 via abobinas+prod3.
            //
            // Also: generate-chapter takes 60-90s, longer than Stripe's 30s
            // webhook timeout. We use EdgeRuntime.waitUntil to keep the trigger
            // alive AFTER we ACK Stripe.
            const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-chapter`;
            const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
            const trigger = fetch(url, {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${key}`,
                "apikey": key,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ story_id: story.id, target_chapter_number: 1 }),
            })
              .then(async (r) => {
                if (r.ok) {
                  console.log(`generate-chapter trigger OK for story ${story.id} (HTTP ${r.status})`);
                } else {
                  const body = await r.text().catch(() => "");
                  console.error(
                    `generate-chapter trigger FAILED for story ${story.id} (HTTP ${r.status}):`,
                    body.slice(0, 500),
                  );
                }
              })
              .catch((e) => console.error(`generate-chapter trigger threw for story ${story.id}:`, e));
            // @ts-ignore EdgeRuntime is a Supabase global
            if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
              // @ts-ignore
              EdgeRuntime.waitUntil(trigger);
            }
          }
        }
      }

      // Meta CAPI: mirror the browser Pixel Purchase on the first invoice,
      // deduped by the shared meta_event_id. No-ops until META_CAPI_TOKEN is set.
      if (inv.billing_reason === "subscription_create") {
        const capi = sendCapiPurchase({
          eventId: meta.meta_event_id ?? "",
          email,
          value: (inv.amount_paid ?? 0) / 100,
          currency: inv.currency ?? "usd",
          fbc: meta.meta_fbc, fbp: meta.meta_fbp,
          clientIp: meta.meta_ip, userAgent: meta.meta_ua, sourceUrl: meta.meta_src,
        });
        // @ts-ignore EdgeRuntime is a Supabase global
        if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(capi);
        else await capi;
      }
    } else if (event.type === "invoice.payment_failed") {
      await db.from("users").update({ subscription_status: "past_due" }).eq("stripe_customer_id", sub.customer as string);
      if (sessionId) await db.from("quiz_sessions").update({ subscription_status: "past_due" }).eq("id", sessionId);
    } else {
      // customer.subscription.updated | deleted
      await db.from("users").update(subFields).eq("stripe_customer_id", sub.customer as string);
      if (sessionId) await db.from("quiz_sessions").update(subFields).eq("id", sessionId);
    }
  } catch (e) {
    console.error("webhook handler error:", e);
    // Allow Stripe to retry; remove the idempotency row so the retry reprocesses.
    try { await db.from("stripe_events").delete().eq("id", event.id); } catch (_) { /* ignore */ }
    return new Response("handler error", { status: 500 });
  }

  return ACK();
});
