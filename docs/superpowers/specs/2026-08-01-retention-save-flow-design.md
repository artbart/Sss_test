# Retention save-flow with lifetime offer

**Date:** 2026-08-01
**Status:** Approved, ready for implementation planning

## Problem

The stated concern was "many users leave after the first month." The data does not support
that framing yet, and designing against it would have aimed the fix three weeks too late.

Measured over the full paid history (2026-06-27 → 2026-07-31, 97 subscribers):

| Signal | Value |
|---|---|
| Cancel requested | 30 people (31% of subscribers) |
| Cancelled on day 0 | 20 of 29 |
| Cancelled within 24h | 25 of 29 |
| Ever renewed | 5 people; only 2 at a real full price ($45.99) |
| Payment failure | 15 people (15%) |
| Never read a chapter | 23 people (24%) |
| Median chapters read | ~4 |

Two conclusions:

1. **No cohort has meaningfully reached month one.** The 4-week buyers from early July are
   hitting their first $45.99 renewal around 2026-08-01. Month-1 churn is imminent but not yet
   observable.
2. **The measurable leak is day 0.** Two-thirds of all cancellations happen within hours of
   payment. Because access is paid-through (cancelling keeps the app usable until
   `current_period_end`), cancelling immediately is the *rational* move for someone who wants
   the intro period but not the $45.99 / $83.99 renewal. These users are opting out of a price
   cliff, not expressing dissatisfaction.

Today `cancel-subscription` is a single unconditional Stripe call. There is no reason capture,
no branch, and no offer — so the reason for that 31% is currently unknowable.

## Goals

- Intercept the cancel click with a branched offer instead of an unconditional cancellation.
- Capture a cancellation reason on every cancel, making churn cause measurable for the first time.
- Introduce a lifetime one-time purchase as the bottom rung for confirmed price objectors.
- Keep the existing cancel path working unchanged as the final fall-through.

## Non-goals

- **Dunning / failed-payment recovery.** 15 of 97 people hit a payment failure — a leak of
  comparable size that no save-flow touches. Deliberately deferred to its own pass.
- **Repricing the funnel.** The $19.99 → $45.99 cliff is plausibly the root cause of day-0
  cancels. This flow will produce the reason data to confirm or refute that; repricing is a
  separate decision made *after* that data lands.
- Win-back email campaigns to already-cancelled users.

## Why not the alternatives

**Stripe Customer Portal cancellation flows.** Native reason capture plus a retention coupon,
almost free to build. Rejected: it cannot branch across pause / lifetime / downgrade, and
lifetime is not a subscription concept, so the portal cannot sell it at all.

**Churnkey / Chargebee retention.** Turnkey and capable. Rejected as premature: another vendor,
another recurring cost, and another auth surface for a 97-customer product.

**Build in-app** (chosen). Every primitive already exists — Stripe client, `events` logging, the
`users` access gate. The only genuinely new concept is the lifetime entitlement.

## The flow

Reason capture first, then **at most two offers**. More than two reads as bargaining and trains
users to always click cancel.

```
Cancel clicked
   │
   ▼  "What's the main reason?"  (one tap, required)
   │
   ├─ Too expensive ────────► 50% off next renewal ──► declined ──► LIFETIME $79
   ├─ Not using it enough ──► Pause 4 weeks ─────────► declined ──► Downgrade $9.99
   ├─ Ran out of stories ───► Pause 4 weeks ─────────► declined ──► cancel
   └─ Something's broken ───► support contact (no offer, no bargaining)
```

Two deliberate constraints:

- **Lifetime appears only behind "too expensive."** It is the one rung that permanently ends
  recurring revenue, so it is gated behind a stated price objection. It must never appear on the
  public pricing page or in the "not using it" branch.
- **The "something's broken" branch offers nothing.** Discounting a user who is reporting a bug
  invites a refund dispute. Route to support.

Every screen has a visible, non-dark-pattern "No thanks, cancel my subscription" affordance. The
final rung's decline calls the existing `cancel-subscription` endpoint unchanged.

### Offer values

All are config constants, expected to be tuned once reason data lands.

| Rung | Value | Rationale |
|---|---|---|
| Pause | 4 weeks | Stripe `pause_collection`; no money moves, costs nothing to offer |
| Discount | 50% off one cycle | Brings the $45.99 renewal to ~$23, just above the $19.99 already accepted |
| Lifetime | **$79 one-time** | "Less than two renewals, keep it forever." ~3× current realized ARPU |
| Downgrade | $9.99 / 4 weeks, 1 story/mo | Half price, one third the quota |

### Why lifetime is financially safe here

`start-authenticated-story-v2/index.ts:20` enforces `MONTHLY_STORY_LIMIT = 3` server-side. That
quota already bounds lifetime liability: a lifetime holder can generate at most ~36 stories/year,
forever. The usual "unlimited lifetime on an AI product is an open-ended loss" objection does not
apply, because unlimited was never sold.

Realized revenue per subscriber today is ≈ $25 — one intro payment, then most cancel. A $79
lifetime sale is roughly 3× that against a bounded cost.

## Architecture

### Repository layout caveat

The only local copy of the edge functions is `Sss_test/sss5/supabase/functions/`. The top-level
`supabase/` directory is a linked-project shell (`gmhbcxylqubhxozomhlt`) with an **empty**
`functions/` directory. Deployed functions may be ahead of these local copies — pull and diff
before editing or deploying anything, or remote work will be overwritten.

### Data model (additive only)

`gmhbcxylqubhxozomhlt` is a shared project. Migrations must be strictly additive: no drops, no
alterations to unrelated tables (notably `casp_notes`).

- `users.lifetime_at timestamptz null` — the lifetime entitlement. Null means no lifetime.
- `users.plan_tier text not null default 'standard'` — drives the per-plan story quota.

Cancellation reasons and offer outcomes are recorded in the existing `events` table, matching the
pattern already used by `cancel-subscription`. No new table.

### Access gating

`MONTHLY_STORY_LIMIT` stops being a module constant and becomes a per-tier lookup:

- `Sss_test/sss5/supabase/functions/start-authenticated-story-v2/index.ts` — the access check at
  line ~70 must accept `lifetime_at IS NOT NULL` as granting access independently of
  `subscription_status` / `current_period_end`. The quota check at line ~84 reads the limit from
  `plan_tier` (`standard` → 3, `lite` → 1).
- `sss-app/assets/lib.js:484` `gateNewStoryNav()` — mirrors the same rules so the UI hint matches
  server enforcement. This is a display gate only; the server remains authoritative.

> **Correction (post-implementation):** this list under-counted the real gates. Two more inlined
> comparisons existed at design time — `start-authenticated-story/index.ts` (the V1 function) and
> `submit-choice/index.ts`, which already imported `access.ts` but destructured `{ periodEnd }`
> from it and ran its own date comparison instead of calling `hasAccess()`. All four gates needed
> the same replacement (implementation Task 3). Note for anyone auditing this by grep: searching
> for the literal string `current_period_end` misses the `submit-choice` case, because the
> destructured variable there is named `periodEnd`.

Lifetime must be granted via a dedicated `lifetime_at` column rather than by writing a
far-future `current_period_end` with `subscription_status: 'active'`. The latter would lie to the
webhook (which overwrites those fields from Stripe) and to the Settings UI.

### New edge function: `retention-offer`

One JWT-authed POST endpoint, mirroring the auth and CORS setup of `cancel-subscription`.

`Body: { action, reason }` where action is one of:

| Action | Behaviour |
|---|---|
| `record_reason` | Logs the selected reason; returns which rung to show |
| `pause` | `stripe.subscriptions.update(..., { pause_collection: { behavior: 'void', resumes_at } })` |
| `discount` | Applies a 50%-off, one-cycle coupon to the subscription |
| `downgrade` | Swaps the subscription item to the `lite` price; sets `plan_tier = 'lite'` |
| `lifetime_checkout` | Creates a Stripe Checkout Session, `mode: 'payment'`, returns its URL |

`cancel-subscription` is **not** modified. It remains the final rung's target, so the currently
working cancel path cannot be destabilised by this work.

### Webhook: lifetime fulfilment

`stripe-webhook` currently handles `invoice.paid`, `invoice.payment_failed`,
`customer.subscription.updated`, and `customer.subscription.deleted`. It gains
`checkout.session.completed` filtered to `mode === 'payment'`.

Ordering is load-bearing:

1. Write `users.lifetime_at = now()`.
2. Then cancel the live subscription.

A failure between the two leaves the user with access rather than locked out. The reverse
ordering could strand a paying customer with no entitlement.

The handler must record the event id in the existing `stripe_events` dedup table, the same as
every other branch, so Stripe retries are idempotent.

### Frontend

`sss-app/settings.html`. The existing `cancelSubBtn` (line ~181) and its click handler
(line ~332) currently call `manageSub("cancel")` directly at line ~314. The button instead opens
the save-flow modal; only the final decline reaches `manageSub("cancel")`.

### Instrumentation

New PostHog events, so deflection rate per rung is a funnel on day one:

- `cancel_reason_selected` — properties: `reason`
- `retention_offer_shown` — properties: `reason`, `rung`
- `retention_offer_accepted` — properties: `reason`, `rung`
- `retention_offer_declined` — properties: `reason`, `rung`

Emitted through the existing chokepoints in `lib.js` / `posthog.js`, alongside the `events`-table
writes already performed by the edge functions.

## Error handling

- A `retention-offer` failure on `record_reason` (the initial reason capture, and each decline)
  falls through to the plain cancel path — the user already pressed Cancel and the flow simply
  cannot start. A failure on an ACCEPT action must never fall through to cancel; it shows a
  failure screen with choices instead, and a `409` (that particular offer is no longer available)
  always shows the server's own message rather than cancelling.
  **Correction (post-implementation):** the original wording of this bullet was an unconditional
  "any retention-offer failure falls through to the plain cancel path," which is wrong and was
  nearly shipped that way. An unset Stripe secret returns `502` and is the expected state on first
  deploy, so that wording would have made auto-cancel the default behaviour of the discount and
  downgrade rungs the moment anyone tried to accept one, before the secrets were ever set.
- Reason capture is written before any offer is shown, so an abandoned flow still yields the
  reason (the most valuable output of this work).
- Stripe errors return the existing `502` shape used by `cancel-subscription`.
- Lifetime checkout abandonment is a no-op: no entitlement written, subscription untouched.

## Testing

- Per-tier quota resolution: `standard` → 3, `lite` → 1, lifetime holder → 3.
- Lifetime holder with `subscription_status = 'canceled'` and a past `current_period_end` still
  passes the access gate.
- Webhook idempotency: replaying one `checkout.session.completed` grants lifetime exactly once.
- Webhook ordering: simulated failure after `lifetime_at` write leaves access intact.
- Each branch of the flow reaches cancellation when every offer is declined.
- Reason is recorded even when the user abandons the modal.

## Success criteria

- Every cancellation carries a reason. Currently 0% do.
- A measurable deflection rate per rung, per reason, visible in PostHog.
- Within roughly one week, enough reason data to decide whether the day-0 leak is a pricing
  problem (→ reprice the renewal cliff) or a value problem (→ the save-flow is the fix).

## Open decisions deferred to data

- Whether $79 is the right lifetime price, or whether take-rate favours a lower anchor.
- Whether the discount rung should be a one-cycle 50% or a permanent lower rate.
- Whether the renewal price itself should change, making the discount rung redundant.
