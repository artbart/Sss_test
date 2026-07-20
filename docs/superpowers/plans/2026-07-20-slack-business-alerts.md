# Slack Business Alerts + /stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cancel-scheduled Slack alert, an account-created Slack alert, and a `/stats` Slack slash command to Stuff So Sweet, per `docs/superpowers/specs/2026-07-20-slack-business-alerts-design.md`.

**Architecture:** Two existing files modified (`_shared/slack.ts`, `stripe-webhook/index.ts`), two new single-file edge functions (`notify-account-created`, `slack-stats`), one additive SQL migration (pg_net trigger on `public.users`). `/stats` verifies Slack HMAC signatures, acks within 3 s, and computes live Stripe stats in `EdgeRuntime.waitUntil`, posting to `response_url`.

**Tech Stack:** Supabase Edge Functions (Deno), `npm:stripe@17` pinned to API `2025-03-31.basil`, Supabase JS admin client, Slack Web API + slash commands.

## Global Constraints

- **No automated tests** (explicit user decision). Every task verifies via `deno check` + deployed manual checks instead. Do NOT add test files or DI layers.
- **Shared Stripe account**: a subscription is SSS's iff `!!sub.metadata?.session_id` (`ours()` — same rule as `stripe-webhook`). Every Stripe-derived stat must apply this filter.
- **Shared Supabase project** (`gmhbcxylqubhxozomhlt`): migrations must be additive only — never drop/alter unrelated objects.
- **Fail-safe notifiers**: Slack sends must never throw into a caller; fire only after primary work; use the `bg()` / `EdgeRuntime.waitUntil` pattern.
- **`handle_new_auth_user` is untouchable** (fail-safe signup path; 2026-07-08 incident).
- All function source lives in `Sss_test/sss5/supabase/functions/`; deploy from `Sss_test/sss5` with `supabase functions deploy <name> --project-ref gmhbcxylqubhxozomhlt`. Every new function needs a `verify_jwt = false` entry in `Sss_test/sss5/supabase/config.toml`.
- Stripe API is Basil (`2025-03-31`): `invoice.subscription`, `charge.invoice`, `payment_intent.invoice` are removed/legacy — use `invoiceSubId()` (reads `invoice.parent.subscription_details.subscription`) and the refund-attribution chain in Task 5.
- Secrets in play: existing `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_PURCHASES`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_1W/4W/8W`; new `SLACK_SIGNING_SECRET`, `ACCOUNT_WEBHOOK_SECRET`.
- Git commits end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01UNhJnwVcVso96YHWfF7bAV`
- All `git` commands run in the `Sss_test` repo root (`/Users/mintarasgrinius/Documents/sss-app/Sss_test`). All `supabase` commands run from `Sss_test/sss5`.

---

### Task 1: New Slack event kinds

**Files:**
- Modify: `sss5/supabase/functions/_shared/slack.ts:14-21`

**Interfaces:**
- Consumes: nothing new.
- Produces: `notifySlack({ kind: "cancel_scheduled" | "account_created", ... })` accepted by the existing `SlackNotifyInput` — Tasks 2 and 3 call these kinds.

- [ ] **Step 1: Extend the kind union and META map**

In `sss5/supabase/functions/_shared/slack.ts`, replace:

```ts
type SlackEventKind = "purchase" | "renewal" | "payment_failed" | "cancellation";

const META: Record<SlackEventKind, { icon: string; title: string }> = {
  purchase: { icon: "🎉", title: "New purchase" },
  renewal: { icon: "🔁", title: "Subscription renewed" },
  payment_failed: { icon: "❌", title: "Payment failed" },
  cancellation: { icon: "👋", title: "Subscription canceled" },
};
```

with:

```ts
type SlackEventKind =
  | "purchase"
  | "renewal"
  | "payment_failed"
  | "cancellation"
  | "cancel_scheduled"
  | "account_created";

const META: Record<SlackEventKind, { icon: string; title: string }> = {
  purchase: { icon: "🎉", title: "New purchase" },
  renewal: { icon: "🔁", title: "Subscription renewed" },
  payment_failed: { icon: "❌", title: "Payment failed" },
  cancellation: { icon: "👋", title: "Subscription canceled" },
  cancel_scheduled: { icon: "🚨", title: "Cancel scheduled" },
  account_created: { icon: "👤", title: "Account created" },
};
```

- [ ] **Step 2: Typecheck**

Run (from `Sss_test/sss5/supabase/functions`): `deno check _shared/slack.ts`
Expected: no errors (npm specifier downloads are fine).

- [ ] **Step 3: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/functions/_shared/slack.ts
git commit -m "feat(slack): add cancel_scheduled and account_created alert kinds"
```

---

### Task 2: Cancel-scheduled alert in stripe-webhook

**Files:**
- Modify: `sss5/supabase/functions/stripe-webhook/index.ts:295-319` (the `customer.subscription.updated | deleted` else-branch)

**Interfaces:**
- Consumes: `notifySlack` kind `"cancel_scheduled"` (Task 1), existing `bg()`, `capturePosthog`, `period`, `meta`, `sessionId`.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the flip detection**

In `stripe-webhook/index.ts`, the final `else` branch currently reads:

```ts
    } else {
      // customer.subscription.updated | deleted
      await db.from("users").update(subFields).eq("stripe_customer_id", sub.customer as string);
      if (sessionId) await db.from("quiz_sessions").update(subFields).eq("id", sessionId);

      if (event.type === "customer.subscription.deleted") {
```

Insert the flip check between the `quiz_sessions` update and the `deleted` block:

```ts
    } else {
      // customer.subscription.updated | deleted
      await db.from("users").update(subFields).eq("stripe_customer_id", sub.customer as string);
      if (sessionId) await db.from("quiz_sessions").update(subFields).eq("id", sessionId);

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
```

- [ ] **Step 2: Typecheck**

Run (from `Sss_test/sss5/supabase/functions`): `deno check stripe-webhook/index.ts`
Expected: no errors.

- [ ] **Step 3: Deploy**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5
supabase functions deploy stripe-webhook --project-ref gmhbcxylqubhxozomhlt
```

Expected: "Deployed Functions on project gmhbcxylqubhxozomhlt: stripe-webhook".
(Remote-drift rule already satisfied: local was diffed against deployed on 2026-07-20 — identical.)

- [ ] **Step 4: Manual verification**

Using a 100%-off test subscription (STRIPE_TEST_PROMO user) — or any test account:
1. In the app Settings, click cancel. Expect a 🚨 "Cancel scheduled" message in the purchases channel with "Access until".
2. Reactivate. Expect NO Slack message.
3. Check function logs for errors: `supabase functions logs stripe-webhook --project-ref gmhbcxylqubhxozomhlt` (or dashboard). Existing purchase/renewal alerts must be unaffected.

- [ ] **Step 5: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/functions/stripe-webhook/index.ts
git commit -m "feat(webhook): Slack alert when cancel_at_period_end flips on"
```

---

### Task 3: notify-account-created edge function

**Files:**
- Create: `sss5/supabase/functions/notify-account-created/index.ts`
- Modify: `sss5/supabase/config.toml` (append function entry)

**Interfaces:**
- Consumes: `notifySlack` kind `"account_created"` (Task 1); `ACCOUNT_WEBHOOK_SECRET` env.
- Produces: HTTP endpoint `POST /functions/v1/notify-account-created` expecting header `x-webhook-secret: <ACCOUNT_WEBHOOK_SECRET>` and body `{"record": {"email": "..."}}` — Task 4's DB trigger calls exactly this.

- [ ] **Step 1: Create the function**

`sss5/supabase/functions/notify-account-created/index.ts`:

```ts
// POST /functions/v1/notify-account-created
//
// Target of the pg_net database webhook that fires AFTER INSERT on
// public.users (see migrations/20260720_account_created_webhook.sql) — i.e.
// on account creation via handle_new_auth_user. Authenticated by a shared
// secret header (ACCOUNT_WEBHOOK_SECRET), NOT JWT.
//
// Always returns 200 once authenticated: a failed Slack post must not make
// pg_net retry-spam. Only `record.email` is read — no other PII goes to Slack.

import { notifySlack } from "../_shared/slack.ts";

const SECRET = Deno.env.get("ACCOUNT_WEBHOOK_SECRET");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SECRET) return new Response("ACCOUNT_WEBHOOK_SECRET not set", { status: 503 });
  if (req.headers.get("x-webhook-secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json() as { record?: { email?: string } };
    await notifySlack({ kind: "account_created", email: body?.record?.email ?? null });
  } catch (e) {
    console.error("notify-account-created failed:", e);
  }
  return new Response("ok", { status: 200 });
});
```

- [ ] **Step 2: Pin verify_jwt in config.toml**

Append to `sss5/supabase/config.toml`:

```toml
[functions.notify-account-created]
verify_jwt = false   # called by the pg_net DB webhook; secured by x-webhook-secret header
```

- [ ] **Step 3: Typecheck**

Run (from `Sss_test/sss5/supabase/functions`): `deno check notify-account-created/index.ts`
Expected: no errors.

- [ ] **Step 4: Set the secret and deploy**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5
SECRET=$(openssl rand -hex 32)
echo "ACCOUNT_WEBHOOK_SECRET=$SECRET"   # save for Task 4's migration apply
supabase secrets set ACCOUNT_WEBHOOK_SECRET=$SECRET --project-ref gmhbcxylqubhxozomhlt
supabase functions deploy notify-account-created --no-verify-jwt --project-ref gmhbcxylqubhxozomhlt
```

Expected: secret set + "Deployed Functions … notify-account-created".

- [ ] **Step 5: Curl verification**

```bash
URL=https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/notify-account-created
# wrong secret -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H 'x-webhook-secret: wrong' -H 'Content-Type: application/json' \
  -d '{"record":{"email":"test@example.com"}}'
# correct secret -> 200 + a 👤 Slack message with test@example.com
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H "x-webhook-secret: $SECRET" -H 'Content-Type: application/json' \
  -d '{"record":{"email":"test@example.com"}}'
```

Expected: `401` then `200`, and the 👤 "Account created" message in the purchases channel.

- [ ] **Step 6: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/functions/notify-account-created/index.ts sss5/supabase/config.toml
git commit -m "feat: notify-account-created edge function (DB-webhook target)"
```

---

### Task 4: DB trigger migration on public.users

**Files:**
- Create: `sss5/supabase/migrations/20260720_account_created_webhook.sql`

**Interfaces:**
- Consumes: the endpoint + header contract from Task 3.
- Produces: trigger `users_account_created_webhook` on `public.users`.

- [ ] **Step 1: Confirm the supabase_functions helper exists**

Run in the Dashboard SQL editor (project `gmhbcxylqubhxozomhlt`):

```sql
select n.nspname, p.proname
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'supabase_functions' and p.proname = 'http_request';
```

Expected: one row. If empty, create any throwaway webhook once via Dashboard → Database → Webhooks (this provisions the schema), then delete it and re-run the check.

- [ ] **Step 2: Write the migration (placeholder committed, never the real secret)**

`sss5/supabase/migrations/20260720_account_created_webhook.sql`:

```sql
-- Slack "account created" alert. Additive only (shared Supabase project).
--
-- Fires AFTER INSERT on public.users — the row handle_new_auth_user seeds on
-- first login. pg_net queues the HTTP call OUTSIDE the signup transaction, so
-- a slow/broken edge function can never reproduce the 2026-07-08
-- "Database error saving new user" incident. handle_new_auth_user untouched.
--
-- __ACCOUNT_WEBHOOK_SECRET__ is substituted at apply time (see DEPLOY.md);
-- the real value must never be committed. It IS visible in pg_trigger inside
-- the DB — acceptable: reading pg_trigger already requires service-role access.

create trigger users_account_created_webhook
  after insert on public.users
  for each row
  execute function supabase_functions.http_request(
    'https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/notify-account-created',
    'POST',
    '{"Content-Type":"application/json","x-webhook-secret":"__ACCOUNT_WEBHOOK_SECRET__"}',
    '{}',
    '1000'
  );
```

- [ ] **Step 3: Apply with the secret substituted**

Using the `$SECRET` value printed in Task 3 Step 4 (if lost, generate a new one and re-run `supabase secrets set ACCOUNT_WEBHOOK_SECRET=...` before applying):

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5
sed "s/__ACCOUNT_WEBHOOK_SECRET__/$SECRET/" \
  supabase/migrations/20260720_account_created_webhook.sql
```

Paste the output into Dashboard → SQL editor and run it (repo convention: migrations applied via dashboard). Expected: `CREATE TRIGGER`.

- [ ] **Step 4: End-to-end verification**

1. Sign up in the app with a fresh test email (magic-link first login).
2. Expect: login succeeds (fail-safe path intact) AND a 👤 "Account created" Slack message with that email.
3. If no message: check `select * from net._http_response order by created desc limit 5;` in SQL editor and the function logs.

- [ ] **Step 5: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/migrations/20260720_account_created_webhook.sql
git commit -m "feat(db): account-created webhook trigger on public.users"
```

---

### Task 5: slack-stats edge function (/stats)

**Files:**
- Create: `sss5/supabase/functions/slack-stats/index.ts`
- Modify: `sss5/supabase/config.toml` (append function entry)

**Interfaces:**
- Consumes: `stripe` client (`_shared/stripe.ts`), `adminClient` (`_shared/db.ts`), envs `SLACK_SIGNING_SECRET`, `STRIPE_PRICE_1W/4W/8W`.
- Produces: HTTP endpoint `POST /functions/v1/slack-stats` implementing the Slack slash-command contract (form body, signature headers, ack JSON, `response_url` follow-up). Task 6 points the Slack app at it.

- [ ] **Step 1: Create the function**

`sss5/supabase/functions/slack-stats/index.ts` — complete file:

```ts
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
// SHARED STRIPE ACCOUNT: this account also hosts other products. Only
// subscriptions carrying metadata.session_id count (ours() — same ownership
// rule as stripe-webhook); invoices/refunds are attributed via their
// subscription through subCache.

import { stripe } from "../_shared/stripe.ts";
import { adminClient } from "../_shared/db.ts";

const SIGNING_SECRET = Deno.env.get("SLACK_SIGNING_SECRET");
const enc = new TextEncoder();
const DAY = 86_400;

// Map Stripe price ids -> funnel plan labels for the plan-mix line.
const PLAN_LABELS: Record<string, string> = {};
for (const [envKey, label] of [
  ["STRIPE_PRICE_1W", "1w"],
  ["STRIPE_PRICE_4W", "4w"],
  ["STRIPE_PRICE_8W", "8w"],
] as const) {
  const id = Deno.env.get(envKey);
  if (id) PLAN_LABELS[id] = label;
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

// deno-lint-ignore no-explicit-any
function ours(sub: any): boolean {
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

type Win = { d7: number; prev7: number; d30: number; prev30: number };
const newWin = (): Win => ({ d7: 0, prev7: 0, d30: 0, prev30: 0 });

function addToWindows(w: Win, tsSec: number, nowSec: number, amount = 1): void {
  const age = nowSec - tsSec;
  if (age < 0) return;
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
  const nowSec = Math.floor(Date.now() / 1000);
  const db = adminClient();

  // subId -> is it an SSS subscription. Seeded by every sub we page through;
  // lazy retrieve for invoice/refund subs we haven't seen (bounded to one
  // lookup per distinct sub per invocation — matters on the shared account).
  const subCache = new Map<string, boolean>();
  // deno-lint-ignore no-explicit-any
  const cacheSub = (s: any) => subCache.set(s.id, ours(s));
  async function subIsOurs(subId: string | null): Promise<boolean> {
    if (!subId) return false;
    const hit = subCache.get(subId);
    if (hit !== undefined) return hit;
    let val = false;
    try {
      val = ours(await stripe.subscriptions.retrieve(subId));
    } catch (e) {
      console.warn("subscriptions.retrieve failed:", subId, e);
    }
    subCache.set(subId, val);
    return val;
  }

  // ---- right now: actives (+trialing), MRR, plan mix ----
  let activeCount = 0;
  let trialingCount = 0;
  let mrrCents = 0;
  const planMix = new Map<string, number>();
  for (const status of ["active", "trialing"] as const) {
    for await (const sub of stripe.subscriptions.list({ status, limit: 100, expand: ["data.discounts"] })) {
      cacheSub(sub);
      if (!ours(sub) || isFullyDiscounted(sub)) continue;
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
  const newSubs = newWin();
  for await (const sub of stripe.subscriptions.list({
    status: "all",
    created: { gte: nowSec - 60 * DAY },
    limit: 100,
    expand: ["data.discounts"],
  })) {
    cacheSub(sub);
    if (!ours(sub)) continue;
    // Checkout creates the Stripe subscription BEFORE payment; incomplete_*
    // are abandoned carts, not signups.
    if (sub.status === "incomplete" || sub.status === "incomplete_expired") continue;
    if (isFullyDiscounted(sub)) continue; // test/free users
    addToWindows(newSubs, sub.created, nowSec);
  }

  // ---- cancellations (caveat: Stripe omits canceled subs of deleted customers) ----
  const cancels = newWin();
  for await (const sub of stripe.subscriptions.list({ status: "canceled", limit: 100, expand: ["data.discounts"] })) {
    cacheSub(sub);
    if (!ours(sub) || isFullyDiscounted(sub)) continue;
    if (sub.canceled_at) addToWindows(cancels, sub.canceled_at, nowSec);
  }

  // ---- revenue: paid invoices > $0 (100%-off promos emit real paid $0 invoices) ----
  const revenue = newWin();
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

  // ---- failed payments (7d): open/uncollectible with attempts ----
  let failed7 = 0;
  for (const status of ["open", "uncollectible"] as const) {
    for await (const inv of stripe.invoices.list({
      status,
      created: { gte: nowSec - 7 * DAY },
      limit: 100,
    })) {
      if ((inv.attempt_count ?? 0) === 0) continue;
      if (!(await subIsOurs(invoiceSubId(inv)))) continue;
      failed7++;
    }
  }

  // ---- refunds (succeeded only), attributed to SSS via invoice -> sub ----
  const refunds = newWin();
  for await (const r of stripe.refunds.list({ created: { gte: nowSec - 60 * DAY }, limit: 100 })) {
    if (r.status !== "succeeded") continue;
    const subId = await refundSubId(r, invoiceSub);
    if (!(await subIsOurs(subId))) continue;
    addToWindows(refunds, r.created, nowSec, r.amount ?? 0);
  }

  // ---- leads (Supabase quiz_sessions) ----
  const iso = (sec: number) => new Date(sec * 1000).toISOString();
  const [leads7, leadsPrev7, leads30, leadsPrev30] = await Promise.all([
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

  return [
    `*📊 Stuff So Sweet — right now*`,
    `Active: *${activeCount}*${trialingCount ? ` (+${trialingCount} trialing)` : ""} · MRR: *${usd(mrrCents)}* · Plans: ${mix}`,
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

// Refund -> SSS subscription. Basil removed charge.invoice /
// payment_intent.invoice, so the primary path is refund.payment_intent ->
// InvoicePayments -> invoice; legacy charge.invoice is the fallback.
// Unattributable refunds are excluded and logged.
// deno-lint-ignore no-explicit-any
async function refundSubId(r: any, invoiceSub: Map<string, string | null>): Promise<string | null> {
  try {
    let invId: string | null = null;
    const pi = typeof r.payment_intent === "string" ? r.payment_intent : r.payment_intent?.id;
    // deno-lint-ignore no-explicit-any
    const ip = (stripe as any).invoicePayments;
    if (pi && ip?.list) {
      for await (const p of ip.list({ payment: { type: "payment_intent", payment_intent: pi }, limit: 10 })) {
        invId = typeof p.invoice === "string" ? p.invoice : p.invoice?.id ?? null;
        if (invId) break;
      }
    }
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
```

- [ ] **Step 2: Pin verify_jwt in config.toml**

Append to `sss5/supabase/config.toml`:

```toml
[functions.slack-stats]
verify_jwt = false   # public POST from Slack; secured by signature verification, not JWT
```

- [ ] **Step 3: Typecheck**

Run (from `Sss_test/sss5/supabase/functions`): `deno check slack-stats/index.ts`
Expected: no errors. (If `expand: ["data.discounts"]` or `invoicePayments` typing complains, the `any`-casts above already cover runtime; fix types only, don't change behavior.)

- [ ] **Step 4: Set a signing secret and deploy**

The real Slack app doesn't exist yet (Task 6). Use a temporary secret so the endpoint is testable now; Task 6 replaces it.

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5
TMP_SIGNING=$(openssl rand -hex 32)
echo "temp SLACK_SIGNING_SECRET=$TMP_SIGNING"
supabase secrets set SLACK_SIGNING_SECRET=$TMP_SIGNING --project-ref gmhbcxylqubhxozomhlt
supabase functions deploy slack-stats --no-verify-jwt --project-ref gmhbcxylqubhxozomhlt
```

- [ ] **Step 5: Curl verification (auth paths + stats pipeline)**

```bash
URL=https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats
BODY='command=%2Fstats&response_url=https%3A%2F%2Fexample.com%2Fnope&user_name=curl'

# 1) unsigned -> 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H 'Content-Type: application/x-www-form-urlencoded' --data "$BODY"

# 2) stale timestamp (10 min old) -> 401
TS=$(( $(date +%s) - 600 ))
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$TMP_SIGNING" -hex | sed 's/^.* //')"
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL" \
  -H "x-slack-request-timestamp: $TS" -H "x-slack-signature: $SIG" \
  -H 'Content-Type: application/x-www-form-urlencoded' --data "$BODY"

# 3) valid signature -> 200 with the "Crunching…" ack JSON
TS=$(date +%s)
SIG="v0=$(printf 'v0:%s:%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$TMP_SIGNING" -hex | sed 's/^.* //')"
curl -s -w '\n%{http_code}\n' -X POST "$URL" \
  -H "x-slack-request-timestamp: $TS" -H "x-slack-signature: $SIG" \
  -H 'Content-Type: application/x-www-form-urlencoded' --data "$BODY"
```

Expected: `401`, `401`, then the ack JSON + `200`.
Then check logs — the full formatted stats text must appear (`stats computed:`), followed by a `response_url post failed:` for the dummy example.com URL (expected):
`supabase functions logs slack-stats --project-ref gmhbcxylqubhxozomhlt`
**Sanity-check the numbers against the Stripe dashboard** (actives, last-30d revenue) — this is the metric-correctness gate.

- [ ] **Step 6: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/functions/slack-stats/index.ts sss5/supabase/config.toml
git commit -m "feat: /stats Slack slash command (slack-stats edge function)"
```

---

### Task 6: Slack app setup + DEPLOY.md + end-to-end

**Files:**
- Modify: `sss5/supabase/DEPLOY.md` (secrets table + new setup section)

**Interfaces:**
- Consumes: deployed `slack-stats` endpoint (Task 5), trigger + function (Tasks 3-4).
- Produces: working `/stats` in Slack; documented setup.

- [ ] **Step 1: Human setup — dedicated Slack app (needs the user)**

Ask the user to do the following (agent cannot):
1. https://api.slack.com/apps → **Create New App** → From scratch → name "SSS" → pick the workspace.
2. **Slash Commands** → Create: command `/stats`, request URL `https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats`, short description "SSS business stats".
3. **Install App** to the workspace.
4. **Basic Information** → copy the **Signing Secret** and provide it.

- [ ] **Step 2: Replace the temporary signing secret**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test/sss5
supabase secrets set SLACK_SIGNING_SECRET=<real value from the user> --project-ref gmhbcxylqubhxozomhlt
```

(Edge functions read env at cold start; secret changes roll out automatically within a minute or two — no redeploy needed.)

- [ ] **Step 3: Update DEPLOY.md**

In `sss5/supabase/DEPLOY.md` add to the secrets table:

```markdown
| `SLACK_SIGNING_SECRET` | Signing secret of the dedicated "SSS" Slack app (Basic Information). Unset ⇒ /stats returns 503. |
| `ACCOUNT_WEBHOOK_SECRET` | Random hex; must match the x-webhook-secret header baked into the users_account_created_webhook trigger. Rotate both together. |
```

And append a new section:

```markdown
## Slack /stats + account-created alerts (one-time setup)

1. api.slack.com → Create App "SSS" → Slash Command `/stats` → request URL
   `https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats` →
   Install to workspace. Copy Basic Information → Signing Secret into
   `SLACK_SIGNING_SECRET`.
2. `supabase secrets set ACCOUNT_WEBHOOK_SECRET=<openssl rand -hex 32>`, then
   apply `migrations/20260720_account_created_webhook.sql` via the SQL editor
   with `__ACCOUNT_WEBHOOK_SECRET__` substituted for the same value (sed shown
   in the migration header). Never commit the real value.
3. Deploy `slack-stats` and `notify-account-created` with `--no-verify-jwt`.
4. Verify with `/stats` in Slack: `operation_timeout` ⇒ the ack/response_url
   async pattern is broken; `dispatch_failed` ⇒ wrong URL or unset secret.
```

- [ ] **Step 4: End-to-end verification**

1. Run `/stats` in Slack. Expect the ephemeral "Crunching the numbers… 📊" ack, then the full in-channel report within ~30 s.
2. Cross-check MRR/actives/revenue once more against the Stripe dashboard.
3. Confirm the earlier alerts still work (logs clean since Task 2/4 deploys).

- [ ] **Step 5: Commit**

```bash
cd /Users/mintarasgrinius/Documents/sss-app/Sss_test
git add sss5/supabase/DEPLOY.md
git commit -m "docs: Slack /stats + account-created alert setup in DEPLOY.md"
```
