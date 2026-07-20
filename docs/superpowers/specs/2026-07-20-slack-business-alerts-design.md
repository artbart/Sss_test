# Slack business alerts + `/stats` — design

Date: 2026-07-20
Source: adaptation of `aicurve/docs/slack-business-alerts-playbook.md` to the
Stuff So Sweet stack (Supabase Edge Functions + Stripe + GitHub Pages funnel).

## Context / what already exists

The deployed `stripe-webhook` already posts Slack alerts via
`_shared/slack.ts` (bot token + `SLACK_CHANNEL_PURCHASES`, both secrets set):
new purchase, renewal, payment failed, subscription ended. Notifiers never
throw and fire via `bg()` / `EdgeRuntime.waitUntil` after the primary work —
the playbook's alert-layer rules are already satisfied.

## Scope (user-approved)

1. **Cancel-scheduled alert** — fire the moment `cancel_at_period_end` flips
   to true (actionable churn), not weeks later when the sub ends.
2. **Account-created alert** — fire on first app login (row inserted into
   `public.users`).
3. **`/stats` slash command** — live business numbers answered in Slack.

Explicitly out of scope: new-lead alert (declined), upsell alert (no add-on
product), reactivation alert, automated tests ("just make it work" style,
matching repo conventions — single-file functions, no DI layer).

## Decisions made during brainstorming

- **Slack app**: a NEW dedicated "SSS" Slack app hosts `/stats` (own signing
  secret). The existing bot token stays for push alerts.
- **Data source**: live Stripe, filtered to SSS; leads from `quiz_sessions`.
  No DB mirror of payments (playbook rule: one source of truth).
- **Refunds**: included, attributed via `refund.payment_intent` (approach A +
  refunds).
- **Shared Stripe account**: every Stripe list call must filter by the
  ownership marker `metadata.session_id` (same `ours()` rule as the webhook).
- **Stripe API**: pinned `2025-03-31.basil` (`npm:stripe@17`). Basil removed
  `invoice.subscription`, `charge.invoice`, `payment_intent.invoice` — use
  the repo's `invoiceSubId()` helper and `invoicePayments.list` for links.

## Files

All source lives in `sss5/supabase/functions/` (verified identical to
deployed versions on 2026-07-20 — no remote drift for touched files).

```
_shared/slack.ts                    MODIFIED  add kinds: cancel_scheduled, account_created
stripe-webhook/index.ts             MODIFIED  cancel-scheduled detection
notify-account-created/index.ts     NEW       DB-webhook target → Slack
slack-stats/index.ts                NEW       /stats slash command
migrations/20260720_account_created_webhook.sql   NEW  pg_net trigger on public.users
sss5/supabase/DEPLOY.md             MODIFIED  setup steps
```

New secrets: `SLACK_SIGNING_SECRET` (from the new Slack app),
`ACCOUNT_WEBHOOK_SECRET` (random; authenticates DB → notify-account-created).
Both functions deploy with `verify_jwt: false`.

## 1. Cancel-scheduled alert

In `stripe-webhook`, inside the `customer.subscription.updated` branch (the
existing `else` arm), before/alongside the state sync:

```ts
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
    properties: { session_id: sessionId, stripe_customer_id: sub.customer as string,
                  current_period_end: period.end },
  }));
}
```

Properties:
- `previous_attributes` is present on every `*.updated` event — no DB read.
- Fires exactly once per cancel click; Stripe event retries are deduped by the
  existing `stripe_events` idempotency insert.
- Catches in-app cancels (`cancel-subscription` fn) AND Stripe-dashboard
  cancels.
- Reactivation (`true → false`) sends nothing in v1.

`_shared/slack.ts` META additions:
`cancel_scheduled: { icon: "🚨", title: "Cancel scheduled" }`,
`account_created: { icon: "👤", title: "Account created" }`.

## 2. Account-created alert

`handle_new_auth_user` must stay fail-safe (2026-07-08 incident), so the
trigger function is NOT touched. Instead, an additive migration creates a
Database-Webhook-style trigger on the seeded table:

```sql
create trigger users_account_created_webhook
after insert on public.users
for each row
execute function supabase_functions.http_request(
  'https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/notify-account-created',
  'POST',
  '{"Content-Type":"application/json","x-webhook-secret":"<ACCOUNT_WEBHOOK_SECRET>"}',
  '{}',
  '1000'
);
```

pg_net queues the HTTP call outside the signup transaction — a hung or failed
edge function cannot roll back account creation. Migration is additive only
(shared Supabase project rule: never drop unrelated objects).

The committed migration keeps the literal `<ACCOUNT_WEBHOOK_SECRET>`
placeholder; the real value is substituted only at apply time (sed/psql var,
step documented in DEPLOY.md) so the secret never lands in git. It is still
visible in the trigger definition inside the DB — acceptable: anyone who can
read pg_trigger already has service-role-level access.

`notify-account-created/index.ts`:
- 401 unless `x-webhook-secret` equals `ACCOUNT_WEBHOOK_SECRET`.
- Reads `record.email` from the pg_net payload, calls
  `notifySlack({ kind: "account_created", email })`.
- Always returns 200 after auth (never make pg_net retry-spam Slack).
- Note: `supabase_functions.http_request` sends the full NEW row as
  `record`; the function must only pull `email` (no other PII to Slack).

## 3. `/stats` — `slack-stats/index.ts`

Single-file function, repo style. Flow:

1. **POST only.** Read raw body ONCE as text (needed byte-exact for HMAC),
   then parse as `application/x-www-form-urlencoded`.
2. **Signature verification** (auth — this endpoint returns revenue data):
   - 503 if `SLACK_SIGNING_SECRET` unset.
   - Reject if `x-slack-request-timestamp` older than 5 min (replay guard).
   - Compute `v0=HMAC_SHA256(secret, "v0:{timestamp}:{rawBody}")` with Web
     Crypto (`crypto.subtle.importKey`/`sign`), constant-time compare against
     `x-slack-signature`; 401 on mismatch. Stats are never computed on auth
     failure.
3. **Ack fast** (Slack kills slash commands at 3 s): schedule the real work
   with `EdgeRuntime.waitUntil`, immediately return
   `{ response_type: "ephemeral", text: "Crunching the numbers…" }`.
4. **Background job**: gather stats, format mrkdwn, POST to `response_url`
   as `{ response_type: "in_channel", text }` (Slack accepts it ≤ 30 min).
   On any error, POST an ephemeral error message instead — never leave the
   user with Slack's generic failure.

### SSS filtering on the shared Stripe account

- `ours(sub) = !!sub.metadata?.session_id` (same rule as stripe-webhook).
- Maintain `subCache: Map<string, boolean>` (subId → ours). Seed it from
  every subscription seen while listing; lazily `subscriptions.retrieve` for
  invoice/refund subs not yet cached.

### Queries (all via `for await` auto-pagination)

| Data | Call | Filter |
|---|---|---|
| Actives (+trialing), MRR, plan mix | `subscriptions.list({status, expand: ["data.discounts.source.coupon"]})` for `active` and `trialing` | `ours()`, drop 100%-off-coupon subs |
| New subs (windows) | `subscriptions.list({status:"all", created:{gte: now−60d}, expand: […coupon]})` | `ours()`, exclude `incomplete`/`incomplete_expired`, drop 100%-off |
| Cancels | `subscriptions.list({status:"canceled"})` bucket by `canceled_at` | `ours()` |
| Revenue | `invoices.list({status:"paid", created:{gte: now−60d}})` | invoice → `invoiceSubId()` → subCache `ours()`; sum `amount_paid > 0` |
| Refunds | `refunds.list({created:{gte: now−60d}})`, `status==="succeeded"` | `refund.payment_intent` → `invoicePayments.list({payment:{type:"payment_intent",payment_intent}})` → invoice → subCache; unattributable ⇒ exclude + `console.warn` |
| Failed payments (7d) | `invoices.list({created:{gte: now−7d}})` statuses `open`/`uncollectible` with `attempt_count > 0` | same invoice→sub filter |
| Leads | Supabase `quiz_sessions` count, `email_captured_at` in window | admin client (`_shared/db.ts`) |

### Metric definitions (playbook, adapted)

- **MRR**: active items `unit_amount × quantity` normalized to monthly
  (week ×52/12, month ÷interval_count, year ÷12). List-price MRR; 100%-off
  subs excluded, partial coupons counted.
- **Windows**: last 7d and last 30d, each vs the preceding equal window;
  `previous === 0` ⇒ "n/a" (never divide by zero — also conversion/churn).
- **Conversion (30d)**: new subs 30d ÷ leads 30d.
- **Churn (30d)**: cancels30 ÷ (actives now + cancels30).
- Caveat carried over: Stripe omits canceled subs of deleted customers —
  deleting test customers in the dashboard removes their cancels from stats.

### Output shape (mrkdwn, one message)

```
*📊 Stuff So Sweet — right now*
Active subscribers: N (+M trialing) · MRR: $X · Plans: 1w×a / 4w×b / 8w×c

*Last 7 days* (vs prev 7d)
New subs N (+x%) · Cancels N (…) · Revenue $X (…) · Refunds $X · Leads N (…)
Failed payments: N

*Last 30 days* (vs prev 30d)
New subs … · Cancels … · Revenue … · Refunds … · Leads …
Lead→paid conversion: x% · Churn: x%
```

## Error handling

- All notifiers keep the existing contract: catch everything, log only, fire
  only after primary work succeeded.
- `slack-stats` background job wraps everything in try/catch → ephemeral
  error to `response_url`.
- `notify-account-created`: 401 on bad secret; 200 otherwise.

## One-time human setup (add to DEPLOY.md)

1. api.slack.com → Create App "SSS" → Slash Command `/stats`, request URL
   `https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats` →
   Install to workspace.
2. Basic Information → copy Signing Secret →
   `supabase secrets set SLACK_SIGNING_SECRET=…`
3. `supabase secrets set ACCOUNT_WEBHOOK_SECRET=<random>` (same value baked
   into the migration's header — regenerate both together).
4. Deploy `slack-stats` + `notify-account-created` with `--no-verify-jwt`;
   redeploy `stripe-webhook`; apply the migration.
5. Verify: run `/stats` (`operation_timeout` ⇒ async pattern broken;
   `dispatch_failed` ⇒ URL/secret wrong). Trigger a test cancel via the app.
   Create a test account and check the 👤 alert.

## Manual verification (no automated tests, per user)

- Signed + unsigned + stale-timestamp curl POSTs against `slack-stats`
  (expect 200-ack / 401 / 401).
- `stripe trigger customer.subscription.updated` style test or a real test-
  mode cancel for the flip detection.
- Confirm existing alerts still fire after `stripe-webhook` redeploy
  (remote-ahead rule: diff before deploying — done 2026-07-20, no drift).
