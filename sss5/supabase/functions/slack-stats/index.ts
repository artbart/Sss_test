// POST /functions/v1/slack-stats
//
// Slack "/stats" slash command -> live business numbers. Secured by Slack
// signature verification (NOT JWT) — this endpoint returns revenue data.
//
// Slack kills slash commands after 3 seconds; cold start + live Stripe
// pagination WILL exceed that. So: verify -> ack immediately -> real work in
// EdgeRuntime.waitUntil -> POST the report to response_url (Slack accepts it
// for up to 30 minutes). On failure, POST an ephemeral error instead.
//
// TWO STRIPE ACCOUNTS: figures are gathered from leadoni and astronaut and
// summed into one combined report. leadoni is shared with PhaseMap, so only
// subscriptions carrying metadata.session_id count there (ours() — same
// ownership rule as stripe-webhook); astronaut is SSS-dedicated, so
// everything on it counts. Invoices/refunds are attributed via their
// subscription through a PER-ACCOUNT subCache — a sub_... id is only
// meaningful on the account that issued it.

import {
  stripeFor,
  STRIPE_ACCOUNTS,
  requiresOwnershipMarker,
  priceFor,
  envKeyFor,
  type StripeAccount,
} from "../_shared/stripe.ts";
import { adminClient } from "../_shared/db.ts";

const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET");
const enc = new TextEncoder();
const DAY = 86_400;

// Map Stripe price ids -> funnel plan labels for the plan-mix line.
// Both accounts' price ids map to the SAME label, so "8w" aggregates across
// leadoni and astronaut into one plan-mix entry rather than splitting in two.
const PLAN_LABELS: Record<string, string> = {};
for (const account of STRIPE_ACCOUNTS) {
  for (const key of ["1W", "4W", "8W"] as const) {
    const id = priceFor(account, key);
    if (id) PLAN_LABELS[id] = key.toLowerCase();
  }
}

// ---------- Slack signature (auth) ----------

function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function validSignature(req: Request, rawBody: string): Promise<boolean> {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || !sig) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false; // replay guard: 5 min
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(SIGNING_SECRET!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`v0:${ts}:${rawBody}`));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(`v0=${hex}`, sig);
}

// ---------- SSS ownership + Basil helpers (same rules as stripe-webhook) ----------

// leadoni is shared with PhaseMap, so SSS subs are identified by
// metadata.session_id. astronaut is SSS-dedicated — everything on it counts,
// including subscriptions created by hand in the dashboard, which the marker
// would otherwise hide.
// deno-lint-ignore no-explicit-any
function ours(sub: any, account: StripeAccount): boolean {
  if (!requiresOwnershipMarker(account)) return true;
  return !!sub?.metadata?.session_id;
}

// Basil: invoice.subscription removed; ref lives under invoice.parent.
// deno-lint-ignore no-explicit-any
function invoiceSubId(inv: any): string | null {
  return inv?.parent?.subscription_details?.subscription ?? inv?.subscription ?? null;
}

// 100%-off coupon = test/free user; excluded from ALL subscriber stats.
// Basil embeds the full Coupon on Discount (`d.coupon`); newer API versions
// nest it under `d.source.coupon` — handle both. Requires expand data.discounts.
// deno-lint-ignore no-explicit-any
function isFullyDiscounted(sub: any): boolean {
  for (const d of sub?.discounts ?? []) {
    const coupon = d?.coupon ?? d?.source?.coupon;
    if (coupon?.percent_off === 100) return true;
  }
  return false;
}

// Subscriptions on a TEST price are ours and pay real (tiny) money, so neither
// ours() nor isFullyDiscounted() catches them — they were silently inflating
// active count, MRR and plan mix. Excluded from ALL stats.
// Built from BOTH accounts: astronaut has its own TEST price, and leaving it
// out would reintroduce the same distortion on the new account.
const TEST_PRICE_IDS = new Set<string>();
for (const account of STRIPE_ACCOUNTS) {
  const id = priceFor(account, "TEST");
  if (id) TEST_PRICE_IDS.add(id);
}

// deno-lint-ignore no-explicit-any
function isTestSub(sub: any): boolean {
  for (const item of sub?.items?.data ?? []) {
    if (item?.price?.id && TEST_PRICE_IDS.has(item.price.id)) return true;
  }
  return false;
}

// List-price MRR contribution of one subscription item, in cents/month.
// deno-lint-ignore no-explicit-any
function monthlyCents(item: any): number {
  const cents = (item?.price?.unit_amount ?? 0) * (item?.quantity ?? 1);
  const r = item?.price?.recurring;
  if (!r) return 0;
  const ic = r.interval_count || 1;
  switch (r.interval) {
    case "week":
      return Math.round((cents * 52) / 12 / ic);
    case "month":
      return Math.round(cents / ic);
    case "year":
      return Math.round(cents / (12 * ic));
    case "day":
      return Math.round((cents * 30) / ic);
    default:
      return 0;
  }
}

// ---------- windows / formatting ----------

type Win = {
  d1: number;
  prev1: number;
  d7: number;
  prev7: number;
  d30: number;
  prev30: number;
};
const newWin = (): Win => ({ d1: 0, prev1: 0, d7: 0, prev7: 0, d30: 0, prev30: 0 });

function addToWindows(w: Win, tsSec: number, nowSec: number, amount = 1): void {
  const age = nowSec - tsSec;
  if (age < 0) return;
  if (age <= 1 * DAY) w.d1 += amount;
  else if (age <= 2 * DAY) w.prev1 += amount;
  if (age <= 7 * DAY) w.d7 += amount;
  else if (age <= 14 * DAY) w.prev7 += amount;
  if (age <= 30 * DAY) w.d30 += amount;
  else if (age <= 60 * DAY) w.prev30 += amount;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// % change vs the preceding equal window; previous === 0 => "n/a" (never /0).
function pct(cur: number, prev: number): string {
  if (prev === 0) return "n/a";
  const p = ((cur - prev) / prev) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(0)}%`;
}

// ---------- stats ----------

// deno-lint-ignore no-explicit-any
async function leadCount(db: any, fromIso: string, toIso: string): Promise<number> {
  const { count, error } = await db
    .from("quiz_sessions")
    .select("id", { count: "exact", head: true })
    .not("email", "is", null)
    .gte("email_captured_at", fromIso)
    .lt("email_captured_at", toIso);
  if (error) {
    console.error("lead count failed:", error);
    return 0;
  }
  return count ?? 0;
}

async function gatherStatsText(): Promise<string> {
  const t0 = Date.now();
  const nowSec = Math.floor(Date.now() / 1000);
  const db = adminClient();

  // Accumulators are shared across BOTH accounts so the report shows one
  // combined picture rather than two half-pictures.
  let activeCount = 0;
  let trialingCount = 0;
  let mrrCents = 0;
  const planMix = new Map<string, number>();
  const newSubs = newWin();
  const cancels = newWin();
  const revenue = newWin();
  const refunds = newWin();
  let failed1 = 0;
  let failed7 = 0;

  for (const account of STRIPE_ACCOUNTS) {
    // A missing key means that account is not configured yet — skip rather
    // than fail the whole report.
    if (!Deno.env.get(envKeyFor(account, "SECRET_KEY"))) {
      console.log(`slack-stats: skipping ${account} — no secret key configured`);
      continue;
    }
    const stripe = stripeFor(account);

    // subId -> is it a countable SSS subscription. PER ACCOUNT on purpose: a
    // sub_... id is only meaningful on the account that issued it, so one
    // shared cache would let a leadoni id answer an astronaut lookup.
    // Seeded by every sub we page through; lazy retrieve for invoice/refund
    // subs we haven't seen (bounded to one lookup per distinct sub).
    const subCache = new Map<string, boolean>();
    // deno-lint-ignore no-explicit-any
    const cacheSub = (s: any) => subCache.set(s.id, ours(s, account) && !isTestSub(s));
    const subIsOurs = async (subId: string | null): Promise<boolean> => {
      if (!subId) return false;
      const hit = subCache.get(subId);
      if (hit !== undefined) return hit;
      let val = false;
      try {
        const sub = await stripe.subscriptions.retrieve(subId);
        val = ours(sub, account) && !isTestSub(sub);
      } catch (e) {
        console.warn(`subscriptions.retrieve failed on ${account}:`, subId, e);
      }
      subCache.set(subId, val);
      return val;
    };

    // ---- right now: actives (+trialing), MRR, plan mix ----
    for (const status of ["active", "trialing"] as const) {
      for await (const sub of stripe.subscriptions.list({ status, limit: 100, expand: ["data.discounts"] })) {
        cacheSub(sub);
        if (!ours(sub, account) || isFullyDiscounted(sub) || isTestSub(sub)) continue;
        if (status === "active") activeCount++;
        else trialingCount++;
        for (const item of sub.items?.data ?? []) {
          mrrCents += monthlyCents(item);
          const label = PLAN_LABELS[item.price?.id ?? ""] ?? item.price?.nickname ?? item.price?.id ?? "?";
          planMix.set(label, (planMix.get(label) ?? 0) + 1);
        }
      }
    }

    // ---- new subscribers (60d lookback covers 30d + prev 30d) ----
    for await (const sub of stripe.subscriptions.list({
      status: "all",
      created: { gte: nowSec - 60 * DAY },
      limit: 100,
      expand: ["data.discounts"],
    })) {
      cacheSub(sub);
      if (!ours(sub, account)) continue;
      // Checkout creates the Stripe subscription BEFORE payment; incomplete_*
      // are abandoned carts, not signups.
      if (sub.status === "incomplete" || sub.status === "incomplete_expired") continue;
      if (isFullyDiscounted(sub) || isTestSub(sub)) continue; // test/free users
      addToWindows(newSubs, sub.created, nowSec);
    }

    // ---- cancellations (caveat: Stripe omits canceled subs of deleted customers) ----
    // Bounded scan: the list API can't filter by canceled_at, so bound by
    // created instead. Any sub cancelable within our 60d windows existed
    // recently; a 2-year created horizon comfortably covers every SSS sub
    // (product launched 2026-04) while keeping this loop from paging the
    // shared account's entire cancellation history forever.
    for await (const sub of stripe.subscriptions.list({
      status: "canceled",
      created: { gte: nowSec - 730 * DAY },
      limit: 100,
      expand: ["data.discounts"],
    })) {
      cacheSub(sub);
      if (!ours(sub, account) || isFullyDiscounted(sub) || isTestSub(sub)) continue;
      if (sub.canceled_at) addToWindows(cancels, sub.canceled_at, nowSec);
    }

    // ---- revenue: paid invoices > $0 (100%-off promos emit real paid $0 invoices) ----
    const invoiceSub = new Map<string, string | null>(); // reused for refund attribution
    for await (const inv of stripe.invoices.list({
      status: "paid",
      created: { gte: nowSec - 60 * DAY },
      limit: 100,
    })) {
      const subId = invoiceSubId(inv);
      if (inv.id) invoiceSub.set(inv.id, subId);
      if ((inv.amount_paid ?? 0) <= 0) continue;
      if (!(await subIsOurs(subId))) continue;
      addToWindows(revenue, inv.created, nowSec, inv.amount_paid ?? 0);
    }

    // ---- failed payments (24h + 7d): open/uncollectible with attempts ----
    for (const status of ["open", "uncollectible"] as const) {
      for await (const inv of stripe.invoices.list({
        status,
        created: { gte: nowSec - 7 * DAY },
        limit: 100,
      })) {
        if ((inv.attempt_count ?? 0) === 0) continue;
        if (!(await subIsOurs(invoiceSubId(inv)))) continue;
        failed7++;
        if (inv.created >= nowSec - 1 * DAY) failed1++;
      }
    }

    // ---- refunds (succeeded only), attributed to SSS via invoice -> sub ----
    for await (const r of stripe.refunds.list({ created: { gte: nowSec - 60 * DAY }, limit: 100 })) {
      if (r.status !== "succeeded") continue;
      const subId = await refundSubId(r, invoiceSub, stripe, account);
      if (!(await subIsOurs(subId))) continue;
      addToWindows(refunds, r.created, nowSec, r.amount ?? 0);
    }
  }

  // ---- leads (Supabase quiz_sessions) ----
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const [leads1, leadsPrev1, leads7, leadsPrev7, leads30, leadsPrev30] = await Promise.all([
    leadCount(db, iso(nowSec - 1 * DAY), iso(nowSec + 60)),
    leadCount(db, iso(nowSec - 2 * DAY), iso(nowSec - 1 * DAY)),
    leadCount(db, iso(nowSec - 7 * DAY), iso(nowSec + 60)),
    leadCount(db, iso(nowSec - 14 * DAY), iso(nowSec - 7 * DAY)),
    leadCount(db, iso(nowSec - 30 * DAY), iso(nowSec + 60)),
    leadCount(db, iso(nowSec - 60 * DAY), iso(nowSec - 30 * DAY)),
  ]);

  // ---- derived ----
  const conversion30 = leads30 === 0 ? "n/a" : `${((newSubs.d30 / leads30) * 100).toFixed(1)}%`;
  const churnDen = activeCount + cancels.d30;
  const churn30 = churnDen === 0 ? "n/a" : `${((cancels.d30 / churnDen) * 100).toFixed(1)}%`;
  const mix = [...planMix.entries()].map(([k, v]) => `${k}×${v}`).join(" / ") || "—";

  console.log(`gatherStats took ${Date.now() - t0}ms across ${STRIPE_ACCOUNTS.length} accounts`);
  return [
    `*📊 Stuff So Sweet — right now*`,
    `Active: *${activeCount}*${trialingCount ? ` (+${trialingCount} trialing)` : ""} · MRR: *${usd(mrrCents)}* · Plans: ${mix}`,
    ``,
    `*Last 24 hours* (vs prev 24h)`,
    `New subs *${newSubs.d1}* (${pct(newSubs.d1, newSubs.prev1)}) · Cancels ${cancels.d1} (${pct(cancels.d1, cancels.prev1)}) · Revenue *${usd(revenue.d1)}* (${pct(revenue.d1, revenue.prev1)}) · Refunds ${usd(refunds.d1)} · Leads ${leads1} (${pct(leads1, leadsPrev1)})`,
    `Failed payments (24h): ${failed1}`,
    ``,
    `*Last 7 days* (vs prev 7d)`,
    `New subs *${newSubs.d7}* (${pct(newSubs.d7, newSubs.prev7)}) · Cancels ${cancels.d7} (${pct(cancels.d7, cancels.prev7)}) · Revenue *${usd(revenue.d7)}* (${pct(revenue.d7, revenue.prev7)}) · Refunds ${usd(refunds.d7)} · Leads ${leads7} (${pct(leads7, leadsPrev7)})`,
    `Failed payments (7d): ${failed7}`,
    ``,
    `*Last 30 days* (vs prev 30d)`,
    `New subs *${newSubs.d30}* (${pct(newSubs.d30, newSubs.prev30)}) · Cancels ${cancels.d30} (${pct(cancels.d30, cancels.prev30)}) · Revenue *${usd(revenue.d30)}* (${pct(revenue.d30, revenue.prev30)}) · Refunds ${usd(refunds.d30)} · Leads ${leads30} (${pct(leads30, leadsPrev30)})`,
    `Lead→paid conversion (30d): *${conversion30}* · Churn (30d): *${churn30}*`,
  ].join("\n");
}

// Basil moved the charge/PI -> invoice link to the InvoicePayment resource,
// and npm:stripe@17's SDK predates it. Query the REST endpoint directly so
// attribution works regardless of SDK version.
async function invoiceIdForPaymentIntent(pi: string, account: StripeAccount): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      "payment[type]": "payment_intent",
      "payment[payment_intent]": pi,
      limit: "10",
    });
    const res = await fetch(`https://api.stripe.com/v1/invoice_payments?${params}`, {
      headers: {
        Authorization: `Bearer ${Deno.env.get(envKeyFor(account, "SECRET_KEY"))}`,
        "Stripe-Version": "2025-03-31.basil",
      },
    });
    if (!res.ok) {
      console.warn("invoice_payments lookup failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const body = await res.json() as { data?: Array<{ invoice?: string | { id?: string } }> };
    for (const p of body.data ?? []) {
      const inv = typeof p.invoice === "string" ? p.invoice : p.invoice?.id ?? null;
      if (inv) return inv;
    }
    return null;
  } catch (e) {
    console.warn("invoice_payments lookup threw:", e);
    return null;
  }
}

// Refund -> SSS subscription. Basil removed charge.invoice /
// payment_intent.invoice, so the primary path is refund.payment_intent ->
// REST invoice_payments lookup -> invoice; legacy charge.invoice is the
// fallback. Unattributable refunds are excluded and logged.
// deno-lint-ignore no-explicit-any
async function refundSubId(
  r: any,
  invoiceSub: Map<string, string | null>,
  // deno-lint-ignore no-explicit-any
  stripe: any,
  account: StripeAccount,
): Promise<string | null> {
  try {
    let invId: string | null = null;
    const pi = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id;
    if (pi) invId = await invoiceIdForPaymentIntent(pi, account);
    if (!invId && r.charge) {
      const chargeId = typeof r.charge === "string" ? r.charge : r.charge.id;
      // deno-lint-ignore no-explicit-any
      const ch = (await stripe.charges.retrieve(chargeId)) as any;
      invId = typeof ch.invoice === "string" ? ch.invoice : ch.invoice?.id ?? null;
    }
    if (!invId) {
      console.warn("refund unattributable (no invoice):", r.id);
      return null;
    }
    if (invoiceSub.has(invId)) return invoiceSub.get(invId)!;
    const inv = await stripe.invoices.retrieve(invId);
    const subId = invoiceSubId(inv);
    invoiceSub.set(invId, subId);
    return subId;
  } catch (e) {
    console.warn("refund attribution failed:", r?.id, e);
    return null;
  }
}

// ---------- Slack plumbing ----------

async function postToResponseUrl(url: string, payload: unknown): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error("response_url post failed:", res.status, await res.text().catch(() => ""));
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SIGNING_SECRET) return new Response("SLACK_SIGNING_SECRET not set", { status: 503 });

  // Raw body FIRST (byte-exact for HMAC), then parse as form data.
  const raw = await req.text();
  if (!(await validSignature(req, raw))) return new Response("Bad signature", { status: 401 });

  const params = new URLSearchParams(raw);
  const responseUrl = params.get("response_url") ?? "";
  if (!responseUrl) return new Response("Missing response_url", { status: 400 });

  const job = (async () => {
    try {
      const text = await gatherStatsText();
      console.log("stats computed:\n" + text);
      await postToResponseUrl(responseUrl, { response_type: "in_channel", text });
    } catch (e) {
      console.error("stats failed:", e);
      await postToResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: "⚠️ Stats failed — check slack-stats function logs.",
      }).catch(() => {});
    }
  })();
  // @ts-ignore EdgeRuntime is a Supabase global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(job);
  else await job; // local dev fallback

  return new Response(
    JSON.stringify({ response_type: "ephemeral", text: "Crunching the numbers… 📊" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
