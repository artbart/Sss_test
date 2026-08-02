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
// The one-time lifetime payment has no subscription to carry that marker, so it
// is identified by metadata.app === "sss" on the Checkout Session instead.
//
// Events: invoice.paid, invoice.payment_failed,
//         customer.subscription.updated, customer.subscription.deleted,
//         checkout.session.completed (one-time lifetime purchase)

import { adminClient } from "../_shared/db.ts";
import { stripe, cryptoProvider } from "../_shared/stripe.ts";
import { sendCapiPurchase } from "../_shared/meta.ts";
import { notifySlack } from "../_shared/slack.ts";
import { capturePosthog } from "../_shared/posthog.ts";
import {
  getGenerateFunctionUrl,
  getQuizTableName,
  getStoriesFkColumn,
  buildStoriesInsertRow,
  type QuizVersion,
} from "../_shared/version_router.ts";
import type Stripe from "npm:stripe@17";

const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;
const ACK = () => new Response("ok", { status: 200 });

// Run a fire-and-forget side effect without delaying the ACK to Stripe.
function bg(p: Promise<unknown>): void {
  // @ts-ignore EdgeRuntime is a Supabase global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(p);
}

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

    // ------------------------------------------------------------------
    // One-time lifetime purchase ($79), created by retention-offer.
    //
    // Handled BEFORE the subscription routing below because that routing
    // resolves a `sub` and calls ours(sub) — and a one-time payment has no
    // subscription for ours() to inspect. On this shared Stripe account the
    // payment is disambiguated by metadata.app instead, which the Checkout
    // Session always carries.
    // ------------------------------------------------------------------
    if (event.type === "checkout.session.completed") {
      const cs = event.data.object as Stripe.Checkout.Session;

      // Ack-and-ignore anything that is not an SSS lifetime payment, BEFORE any
      // DB write — exactly the rule the subscription branches follow for
      // non-SSS events. None of these is an error: other products' checkout
      // sessions legitimately arrive at this endpoint.
      if (cs.mode !== "payment") return ACK();               // a subscription checkout, fulfilled via invoice.paid
      if ((cs.metadata?.app ?? "") !== "sss") {
        // Almost always another product on this shared account, which is why
        // this is an ACK and not an error. Logged anyway: if the marker is ever
        // misplaced or the key typo'd on our side, the failure mode is a paid
        // customer with no grant, and without this line it is undiagnosable.
        // Volume is low — the mode === "payment" check already ran.
        console.log(`checkout.session.completed ignored: session ${cs.id}, metadata.app=${JSON.stringify(cs.metadata?.app ?? null)}`);
        return ACK();
      }
      if (cs.payment_status !== "paid") {
        // Delayed payment method, or a session completed without funds. We do
        // not fulfil on credit, and checkout.session.async_payment_succeeded is
        // not an enabled event, so make the drop visible instead of silent.
        console.warn(
          `sss lifetime checkout ${cs.id} completed with payment_status=` +
          `${cs.payment_status}; NOT fulfilling`,
        );
        return ACK();
      }
      const uid = cs.metadata?.supabase_user_id;
      if (!uid) {
        console.error(
          `sss lifetime checkout ${cs.id} carries no supabase_user_id; ` +
          `cannot fulfil — MANUAL GRANT REQUIRED`,
        );
        return ACK();
      }

      // Idempotency: same table and same first-writer-wins rule as every other
      // branch, because Stripe retries this event.
      //
      // FAILURE POLICY FOR EVERYTHING BELOW THIS LINE. This insert CLAIMS the
      // event. The catch at the bottom of this try is what RELEASES the claim
      // (it deletes the row) so a Stripe retry reprocesses. A bare `return`
      // never reaches that catch: it would leave the claim in place, the retry
      // would hit the duplicate and receive "ok (dup)", and the purchase would
      // never be fulfilled while Stripe's dashboard showed a handled event.
      // Therefore:
      //   * BEFORE the entitlement lands, the only way to fail is to `throw`;
      //   * AFTER it lands, nothing may throw — a throw would release the claim
      //     and re-run a grant that already succeeded.
      //
      // A non-null error here is NOT proof of a duplicate. postgrest-js folds
      // connection resets, timeouts, PostgREST 503s and Supabase restarts into
      // the same `error` object, and answering any of those with "ok (dup)"
      // would have Stripe mark the event delivered while the grant was never
      // attempted — a paid customer, silently unfulfilled. stripe_events.id is
      // a `text primary key`, so only 23505 (unique_violation) means the claim
      // was already taken; everything else takes the throw path.
      const { error: dupErr } = await db.from("stripe_events").insert({ id: event.id, type: event.type });
      if (dupErr) {
        if (dupErr.code !== "23505") {
          console.error(`lifetime dedup claim failed for session ${cs.id} (event ${event.id}):`, dupErr);
          // Safe even though the claim may never have been written: the catch's
          // compensating delete is a no-op on a missing row.
          throw new Error("dedup claim failed"); // -> release + 500, Stripe retries
        }
        return new Response("ok (dup)", { status: 200 });
      }

      // ORDER IS LOAD-BEARING: grant the entitlement FIRST, cancel the live
      // subscription SECOND. A failure between the two leaves the customer with
      // access they have paid for (at worst one more billing cycle). The
      // reverse would strand a paying customer with nothing.
      //
      // .select("id") is not decoration: supabase-js never throws on a failed
      // write, and an UPDATE matching zero rows resolves as error:null with an
      // empty data array. Without checking the returned rows, a bad
      // supabase_user_id would be indistinguishable from a successful grant.
      //
      // ⚠ plan_tier IS A ONE-WAY DOOR. This is the only writer of 'standard'
      // (it lifts a previously-downgraded buyer back to the 3/month quota they
      // just paid $79 for); the only writer of 'lite' is the downgrade rung in
      // retention-offer. Nothing else resets it — not invoice.paid, not
      // customer.subscription.updated, not a resubscribe. A lite user put back
      // on a standard price by any route OTHER than this lifetime purchase
      // keeps plan_tier='lite' and silently gets 1 story/month at full price.
      // REVERSING A DOWNGRADE MEANS UPDATING THIS COLUMN TOO. Runbook and SQL:
      // docs/superpowers/specs/2026-08-01-retention-save-flow-design.md,
      // "Operational notes".
      const { data: granted, error: grantErr } = await db.from("users")
        .update({ lifetime_at: new Date().toISOString(), plan_tier: "standard" })
        .eq("id", uid)
        .select("id");
      if (grantErr) {
        console.error(`lifetime grant failed for user ${uid} (session ${cs.id}):`, grantErr);
        throw new Error("lifetime grant failed"); // -> catch releases the claim, Stripe retries
      }
      if (!granted || granted.length === 0) {
        console.error(`lifetime grant matched NO users row for ${uid} (session ${cs.id})`);
        throw new Error("lifetime grant matched no user"); // -> catch releases the claim, Stripe retries
      }

      // --- Entitlement is live. Everything past here logs and never throws. ---

      const { data: u, error: readErr } = await db.from("users")
        .select("email, stripe_subscription_id").eq("id", uid).maybeSingle();
      // "was the old subscription dealt with?" — drives the Slack copy below,
      // because "lifetime granted, still billing" is a state that needs a human
      // and "lifetime granted, nothing left to bill" is not.
      let subDisposition = "none linked";
      if (readErr) {
        // Only feeds the cancel and the audit row, both of which are
        // best-effort now that the grant has landed.
        subDisposition = "UNKNOWN — follow-up read failed, NOT cancelled";
        console.error(
          `LIFETIME GRANTED for ${uid} but the follow-up read failed; the ` +
          `subscription was NOT cancelled — CANCEL BY HAND:`,
          readErr,
        );
        // Same reason as the cancel-failure branch below: a console line is
        // invisible until someone goes looking, and this leaves a customer who
        // may still be billed. Page a human.
        bg(notifySlack({
          kind: "lifetime_cancel_failed",
          sessionId: cs.id,
          customerId: typeof cs.customer === "string" ? cs.customer : null,
          fields: {
            "User id": uid,
            "What happened": "Lifetime granted, but the users-row read failed so the subscription was never cancelled",
            "Action": "Find this user's Stripe subscription and cancel it by hand",
          },
        }));
      } else if (u?.stripe_subscription_id) {
        try {
          await stripe.subscriptions.cancel(u.stripe_subscription_id);
          subDisposition = `cancelled (${u.stripe_subscription_id})`;
          console.log(`lifetime granted for ${uid}; cancelled subscription ${u.stripe_subscription_id}`);
        } catch (e) {
          // Deliberately NOT a throw, unlike the entitlement write above: the
          // customer already holds what they paid for, and throwing here would
          // roll back the claim and re-run the grant. This leaves a live
          // subscription that a human must cancel.
          subDisposition = `STILL LIVE — cancel failed (${u.stripe_subscription_id})`;
          console.error(
            `LIFETIME GRANTED for ${uid} BUT CANCEL FAILED for subscription ` +
            `${u.stripe_subscription_id} — CANCEL BY HAND:`,
            e,
          );
          // A console.error alone is not an alert. This branch leaves a
          // customer holding lifetime AND a live billing subscription, so it
          // has to reach a person. Settings now keeps the cancel button
          // visible in that state too, but we must not rely on the customer
          // noticing they are being double-charged.
          bg(notifySlack({
            kind: "lifetime_cancel_failed",
            email: u?.email ?? null,
            sessionId: cs.id,
            customerId: typeof cs.customer === "string" ? cs.customer : null,
            fields: {
              "User id": uid,
              "Subscription": u.stripe_subscription_id,
              "What happened": "Lifetime granted, but stripe.subscriptions.cancel failed — the customer is still being billed",
              "Action": "Cancel this subscription by hand",
            },
          }));
        }
      } else {
        console.log(`lifetime granted for ${uid}; no linked subscription to cancel`);
      }

      const { error: evErr } = await db.from("events").insert({
        user_id: uid,
        email: u?.email ?? null,
        event_type: "lifetime_purchased",
        metadata: {
          stripe_event_id: event.id,
          checkout_session_id: cs.id,
          amount_total: cs.amount_total,
          currency: cs.currency,
        },
      });
      if (evErr) console.error(`events lifetime_purchased insert failed for ${uid}:`, evErr);

      // Same fire-and-forget treatment every other money event gets (see
      // invoice.paid below): notifySlack/capturePosthog swallow their own
      // errors, and bg() keeps them off the ACK path so neither can delay or
      // fail the response to Stripe. Both run AFTER the grant, so by policy
      // neither may throw — bg() guarantees that structurally.
      bg(notifySlack({
        kind: "lifetime_purchase",
        email: u?.email ?? null,
        amount: (cs.amount_total ?? 0) / 100,
        currency: cs.currency,
        sessionId: cs.id,
        customerId: typeof cs.customer === "string" ? cs.customer : null,
        fields: { "User id": uid, "Old subscription": subDisposition },
      }));

      // Fired as `retention_offer_accepted` with rung "lifetime" ON PURPOSE.
      // The client deliberately does not fire it for this rung (nobody has paid
      // at the point the browser hands off to Stripe), which left the funnel as
      // retention_offer_shown{rung:lifetime} -> nothing, making the spec's
      // "deflection rate per rung" unmeasurable for the one rung that brings in
      // the most money. This closes the funnel from the only place that knows
      // the payment actually completed. `reason` is not knowable here — the
      // stated reason lives on the earlier lifetime_checkout_started row in
      // `events`, joinable by checkout_session_id.
      bg(capturePosthog({
        event: "retention_offer_accepted",
        distinctId: (u?.email ?? "").toLowerCase() || uid,
        properties: {
          rung: "lifetime",
          amount: (cs.amount_total ?? 0) / 100,
          currency: (cs.currency ?? "usd").toUpperCase(),
          checkout_session_id: cs.id,
          stripe_customer_id: typeof cs.customer === "string" ? cs.customer : null,
          subscription_disposition: subDisposition,
        },
      }));

      return ACK();
    }

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
    // Quiz version (defaults to 1 for backward compat with pre-V2 subscriptions).
    const quizVersion = (parseInt(String(meta.quiz_version ?? "1"), 10) || 1) as QuizVersion;
    const quizTable = getQuizTableName(quizVersion);
    const storiesFk = getStoriesFkColumn(quizVersion);
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
        // Update the version-appropriate quiz_sessions or quizN_sessions table.
        await db.from(quizTable).update({
          ...subFields,
          paid: true,
          payment_at: new Date().toISOString(),
          status: "paid",
        }).eq("id", sessionId);
      }
      // Sync + link the users row. Two steps, because two different failure modes
      // pull the match predicate in opposite directions and both are real:
      //
      //   #94 (Gibson/Quasi, Jul 27) — this Stripe account is shared with PhaseMap,
      //   so a customer can hold both an SSS sub and a PhaseMap sub. Matching on
      //   customer id alone lets another product's event overwrite our row.
      //
      //   fargofour@gmail.com (Jul 09) — a user who signs up BEFORE paying gets a
      //   users row with stripe_customer_id AND stripe_subscription_id both NULL
      //   (handle_new_auth_user finds no paid session; create-subscription mirrors
      //   the ids onto the quiz table, not onto users). Matching on those ids hits
      //   zero rows, so the sub is never linked and Settings hides the entire
      //   Subscription section for a paying customer — permanently.
      //
      // These reconcile once you separate "row tracks a DIFFERENT sub" (never touch)
      // from "row tracks NO sub yet" (safe to claim).

      // Step 1 — the row already tracking this subscription. Narrow match keeps #94 fixed.
      const { data: synced, error: syncErr } = await db
        .from("users").update(subFields)
        .eq("stripe_customer_id", sub.customer as string)
        .eq("stripe_subscription_id", sub.id)
        .select("id");
      if (syncErr) console.error("users sync by customer+sub id failed:", syncErr);

      // Step 2 — nothing tracked this sub yet: claim an UNLINKED row by email.
      // Identity is email-keyed, so email is the safe join. The .is(null) guard is
      // what preserves #94: a row already holding another sub id simply doesn't
      // match, so a PhaseMap-linked row can never be hijacked here.
      if ((!synced || synced.length === 0) && email) {
        // Respect UNIQUE(stripe_customer_id): if this customer id is already
        // attached to some other users row, writing it again would 23505.
        const { data: taken } = await db
          .from("users").select("id")
          .eq("stripe_customer_id", sub.customer as string)
          .limit(1).maybeSingle();

        if (taken) {
          console.warn(
            `customer ${sub.customer} already attached to users row ${taken.id}; ` +
            `skipping email link for ${email}`,
          );
        } else {
          const claimFields: Record<string, unknown> = {
            ...subFields,
            stripe_customer_id: sub.customer as string,
            stripe_subscription_id: sub.id,
          };
          if (meta.plan) claimFields.subscription_plan = meta.plan;

          const { data: claimed, error: claimErr } = await db
            .from("users").update(claimFields)
            .eq("email", email)
            .is("stripe_subscription_id", null)
            .select("id");
          if (claimErr) console.error("users link by email failed:", claimErr);
          else if (claimed && claimed.length > 0) {
            console.log(`users linked by email fallback for ${email} (${claimed.length} row)`);
          } else {
            // Known gap: a RESUBSCRIBE lands here. The row holds a stale sub id, so
            // step 1 misses and .is(null) blocks the claim. Deliberately not handled
            // — telling "stale SSS sub" from "live PhaseMap sub" needs a Stripe
            // lookup, and guessing wrong re-opens #94. Alert instead of silently
            // dropping it.
            console.error(
              `UNLINKED SUB: ${email} paid on ${sub.id} but no users row could be ` +
              `linked (row likely holds a different sub id). Manual link required.`,
            );
          }
        }
      }

      // First invoice -> create story + trigger chapter 1 (once).
      if (inv.billing_reason === "subscription_create" && sessionId && email) {
        // Idempotency check must be version-aware (looks at the correct FK column).
        const { data: already } = await db
          .from("stories").select("id").eq(storiesFk, sessionId).limit(1).maybeSingle();
        if (!already) {
          // Build the version-appropriate insert row (session_id for V1, quizN_session_id for V2+).
          const insertRow = {
            ...buildStoriesInsertRow(quizVersion, sessionId),
            lead_email: email,
            status: "pending",
          };
          const { data: story, error: stErr } = await db.from("stories")
            .insert(insertRow)
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
            }).then(({ error: evErr }: { error: unknown }) => {
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
            // Version-aware routing: V1 → generate-chapter, V2 → generate-chapter-v2, etc.
            const url = getGenerateFunctionUrl(quizVersion);
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

      // Slack: new purchase on the first invoice, otherwise a renewal.
      bg(notifySlack({
        kind: inv.billing_reason === "subscription_create" ? "purchase" : "renewal",
        email,
        amount: (inv.amount_paid ?? 0) / 100,
        currency: inv.currency,
        sessionId,
        customerId: sub.customer as string,
        fields: { Status: sub.status, "Renews/ends": period.end },
      }));

      // PostHog: authoritative revenue conversion, keyed on email.
      bg(capturePosthog({
        event: inv.billing_reason === "subscription_create" ? "subscription_started" : "subscription_renewed",
        distinctId: email || (sub.customer as string),
        properties: {
          amount: (inv.amount_paid ?? 0) / 100,
          currency: (inv.currency ?? "usd").toUpperCase(),
          billing_reason: inv.billing_reason ?? null,
          subscription_status: sub.status,
          session_id: sessionId,
          stripe_customer_id: sub.customer as string,
        },
      }));
    } else if (event.type === "invoice.payment_failed") {
      // Filter by BOTH customer_id AND subscription_id to prevent Stripe-account-sharing bugs
      // (e.g. PhaseMap sub going past_due on a customer who also has an active SSS sub would
      // otherwise flip our SSS user to past_due). See task #94 / Gibson/Quasi incident Jul 27.
      await db.from("users").update({ subscription_status: "past_due" })
        .eq("stripe_customer_id", sub.customer as string)
        .eq("stripe_subscription_id", sub.id);
      if (sessionId) await db.from(quizTable).update({ subscription_status: "past_due" })
        .eq("id", sessionId)
        .eq("stripe_subscription_id", sub.id);

      bg(notifySlack({
        kind: "payment_failed",
        email: (meta.email ?? inv.customer_email ?? "").toLowerCase() || null,
        amount: (inv.amount_due ?? inv.amount_paid ?? 0) / 100,
        currency: inv.currency,
        sessionId,
        customerId: sub.customer as string,
      }));

      bg(capturePosthog({
        event: "subscription_payment_failed",
        distinctId: (meta.email ?? inv.customer_email ?? "").toLowerCase() || (sub.customer as string),
        properties: {
          amount: (inv.amount_due ?? inv.amount_paid ?? 0) / 100,
          currency: (inv.currency ?? "usd").toUpperCase(),
          session_id: sessionId,
          stripe_customer_id: sub.customer as string,
        },
      }));
    } else {
      // customer.subscription.updated | deleted
      // Filter by BOTH customer_id AND subscription_id — this Stripe account is shared with
      // PhaseMap, so a customer can hold both an SSS sub AND a PhaseMap sub. Without the
      // sub.id filter, a PhaseMap cancellation event overwrites the SSS user's active status
      // to "canceled". This is the root cause of the Gibson/Quasi incident (task #94).
      // If sub.id doesn't match the row we track for this customer, the update is a safe no-op.
      await db.from("users").update(subFields)
        .eq("stripe_customer_id", sub.customer as string)
        .eq("stripe_subscription_id", sub.id);
      if (sessionId) await db.from(quizTable).update(subFields)
        .eq("id", sessionId)
        .eq("stripe_subscription_id", sub.id);

      // Actionable churn: alert the moment cancel_at_period_end flips to true
      // (user clicked cancel — in-app or Stripe dashboard). previous_attributes
      // is present on every *.updated event, so no DB read is needed; Stripe
      // event retries are already deduped by the stripe_events insert above.
      // Reactivation (true -> false) intentionally sends nothing.
      if (event.type === "customer.subscription.updated") {
        const prev = (event.data as { previous_attributes?: { cancel_at_period_end?: boolean } })
          .previous_attributes;
        if (sub.cancel_at_period_end === true && prev?.cancel_at_period_end === false) {
          bg(notifySlack({
            kind: "cancel_scheduled",
            email: meta.email ?? null,
            sessionId,
            customerId: sub.customer as string,
            fields: { "Access until": period.end },
          }));
          bg(capturePosthog({
            event: "subscription_cancel_scheduled",
            distinctId: meta.email || (sub.customer as string),
            properties: {
              session_id: sessionId,
              stripe_customer_id: sub.customer as string,
              current_period_end: period.end,
            },
          }));
        }
      }

      if (event.type === "customer.subscription.deleted") {
        bg(notifySlack({
          kind: "cancellation",
          email: meta.email ?? null,
          sessionId,
          customerId: sub.customer as string,
          fields: { "Canceled at period end": sub.cancel_at_period_end ?? false },
        }));

        bg(capturePosthog({
          event: "subscription_canceled",
          distinctId: meta.email || (sub.customer as string),
          properties: {
            cancel_at_period_end: sub.cancel_at_period_end ?? false,
            session_id: sessionId,
            stripe_customer_id: sub.customer as string,
          },
        }));
      }
    }
  } catch (e) {
    console.error("webhook handler error:", e);
    // Allow Stripe to retry; remove the idempotency row so the retry reprocesses.
    // If this compensating delete itself fails the claim is stuck and the retry
    // will short-circuit on "ok (dup)", so make that visible — supabase-js
    // reports it in `error` rather than throwing, hence both checks.
    try {
      const { error: relErr } = await db.from("stripe_events").delete().eq("id", event.id);
      if (relErr) {
        console.error(
          `FAILED TO RELEASE idempotency claim for event ${event.id}; the Stripe ` +
          `retry will be deduped and this event will never be reprocessed:`,
          relErr,
        );
      }
    } catch (relEx) {
      console.error(`FAILED TO RELEASE idempotency claim for event ${event.id}:`, relEx);
    }
    return new Response("handler error", { status: 500 });
  }

  return ACK();
});
