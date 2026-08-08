# Stripe dual-account (leadoni → astronaut) — design

Date: 2026-08-08

## Goal

Bill **new** customers on a second, SSS-dedicated Stripe account. Existing
customers keep being billed on the current account, with every self-serve
billing flow continuing to work for them unchanged.

This is not a migration. No customer, subscription, or card moves. Both
accounts stay live indefinitely; the split is permanent as far as the code is
concerned.

## The two accounts

Both have the Stripe display name **"StuffSoSweet"**, so the display name is
useless as a safety check. The `acct_` id — and the account fingerprint Stripe
embeds in every key and object id — is the only reliable discriminator.

| Label | `acct_` id | Fingerprint | Notes |
|---|---|---|---|
| `leadoni` | `acct_1TRcmOKD4axecwd4` | `KD4axecwd4` | current; **shared with PhaseMap** |
| `astronaut` | `acct_1U287eKdnhowNC0W` | `KdnhowNC0W` | new (under "monokodas"); SSS-dedicated |

Labels are `leadoni` / `astronaut` per user preference, even though neither
matches a Stripe display name. `_shared/stripe.ts` carries the label → `acct_`
mapping as a comment *and* as a boot-time assertion (below), so the mismatch is
documented rather than discovered.

## Scope (user-approved)

- Every billing flow works on both accounts: cancel, retention save-offers,
  lite downgrade, lifetime upgrade, story packs.
- `create-subscription` (the funnel) is astronaut-only — new signups only.
- Story packs work for leadoni customers too.

Out of scope: migrating existing customers' cards to astronaut (Stripe supports
a PAN migration by request; explicitly not wanted), and any later consolidation
of the two accounts.

## Decisions

- **Routing via an explicit column.** `stripe_account text not null default
  'leadoni'` on `users`, `quiz_sessions`, `quiz2_sessions`. The default means
  every existing row is correct the moment the column exists — no backfill
  pass. Rejected: try-astronaut-then-fall-back-to-leadoni (every leadoni call
  pays a wasted round trip, and a genuinely deleted subscription becomes
  indistinguishable from a routing miss) and date-based routing (misroutes the
  signup-before-pay case already documented in project notes).
- **Existing secrets are never touched.** All current `STRIPE_*` secrets keep
  their names and values and mean leadoni. Astronaut gets a parallel
  `STRIPE_ASTRONAUT_*` set. Nothing that bills today changes, so the worst
  failure mode is that *new* signups break — loud and immediate — rather than
  existing billing silently regressing.
- **Coupons need no per-account config.** Coupon ids are caller-chosen, and all
  three (`da8lCgTH`, `rzYEbzrc`, `bxuG6R1e`) exist on both accounts with
  identical ids and terms. Only prices need a dual map.
- **Ownership filtering becomes per-account.** `ours()` (`metadata.session_id`)
  exists because leadoni is shared with PhaseMap. Astronaut is dedicated, so it
  counts everything. This is a correctness improvement, not just a
  simplification: on a dedicated account a subscription created by hand in the
  dashboard *should* appear in `/stats-sss`, and today's filter would hide it.
- **Webhook: one endpoint, two signing secrets.** Same URL registered in both
  accounts; whichever secret verifies identifies the account. An HMAC is
  microseconds, so the failed first attempt costs nothing. Rejected: separate
  `?account=` URLs — louder on misconfiguration, but two endpoint configs to
  keep in sync.

## Stripe-side state — DONE 2026-08-08

Astronaut's products/prices/coupons were created by a colleague before this
design existed. Auditing them found **four of seven prices had the wrong
billing interval**:

| Plan | leadoni | astronaut (as created) | impact |
|---|---|---|---|
| 4-week | every 4 weeks | every 1 month | 12 vs 13.04 charges/yr ⇒ ~8% revenue loss |
| 8-week | every 8 weeks | every 2 months | 6 vs 6.52 charges/yr ⇒ ~8% revenue loss |
| Lighter | every 4 weeks | every **1 week** | **4× overcharge** ($520/yr vs $130/yr) |
| TEST 50c | every 1 week | every 1 month | test price only |

The Lighter plan is the retention *downgrade* rung — offered to customers
already trying to cancel — so quadruple-billing them would have been the worst
possible place for this bug. `4 weeks` and `1 month` look interchangeable in
the Stripe dashboard (which defaults to monthly) but are entirely different
recurrences; nothing in the UI flags the divergence and both show the same
dollar amount.

Fixed by creating four replacement prices, repointing each product's
`default_price` (Stripe refuses to archive a default price, so the order
matters), then archiving the originals with `ARCHIVED — wrong interval…`
nicknames. Zero subscriptions existed on astronaut, so this was free. With live
subscriptions attached it would have required per-subscription price migration
with proration — `unit_amount` and `recurring` are immutable after creation.

Also created `bxuG6R1e` (Retention save 50%, one cycle) on astronaut, which was
missing entirely and would have broken the save-50 rung.

### Final astronaut price map

| Plan | Price id | Amount | Interval |
|---|---|---|---|
| 1-week | `price_1U28heKdnhowNC0W4H1DgmsB` | $29.99 | 1 week |
| 4-week | `price_1U2AUAKdnhowNC0WTj6opoY5` | $45.99 | 4 weeks |
| 8-week | `price_1U2AUDKdnhowNC0WKdtw1sgQ` | $83.99 | 8 weeks |
| Lighter (lite) | `price_1U2AUNKdnhowNC0WRsfcLnY5` | $9.99 | 4 weeks |
| Lifetime | `price_1U28leKdnhowNC0WZTxRjUhZ` | $79.00 | one-time |
| Story pack | `price_1U28mFKdnhowNC0Wh25Sm5nm` | $4.99 | one-time |
| TEST 50c | `price_1U2AUQKdnhowNC0WWGdTVPrS` | $0.50 | 1 week |

Coupons on both accounts: `da8lCgTH` (4-week intro, $26 off),
`rzYEbzrc` (8-week intro, $54 off), `bxuG6R1e` (retention 50% once).

## Architecture

### `_shared/stripe.ts`

Replace the single `stripe` singleton with a registry:

```ts
export type StripeAccount = "leadoni" | "astronaut";

const EXPECTED_ACCT: Record<StripeAccount, string> = {
  leadoni:   "acct_1TRcmOKD4axecwd4",   // display name "StuffSoSweet", shared with PhaseMap
  astronaut: "acct_1U287eKdnhowNC0W",   // display name "StuffSoSweet", SSS-dedicated
};

export function stripeFor(a: StripeAccount): Stripe;
export function planConfig(a: StripeAccount, plan: string): PlanConfig | null;
export function requiresOwnershipMarker(a: StripeAccount): boolean; // true for leadoni only
```

**Boot-time account assertion.** Both accounts share a display name and their
`acct_` ids differ only after a common prefix, so a mis-set secret is easy to
create and invisible afterwards. On first use of each client, verify the
account it actually reports matches `EXPECTED_ACCT` and throw if not. This
converts a silent cross-account write into an immediate failure.

The hardcoded story-pack price at `create-story-pack-checkout` moves into the
per-account map — it cannot stay a bare constant once there are two accounts.

### Schema

```sql
alter table users add column stripe_account text not null default 'leadoni'
  check (stripe_account in ('leadoni','astronaut'));
-- identical for quiz_sessions and quiz2_sessions
```

Additive only, per the project's migration rule. `users.stripe_customer_id`
keeps its plain UNIQUE constraint — Stripe ids carry enough randomness that
cross-account collision isn't a real risk, and altering a live unique
constraint is a far bigger swing than this warrants.

### Call sites

| File | Change |
|---|---|
| `create-subscription` | hardcode `astronaut`; write `stripe_account:'astronaut'` onto the quiz session |
| `cancel-subscription` | `stripeFor(profile.stripe_account)` |
| `retention-offer` (7 call sites) | read the account once at the top from the profile, use throughout |
| `create-story-pack-checkout` | account-aware client + per-account price |
| `stripe-webhook` | account derived from which signing secret verifies, then **threaded into every handler** |
| `slack-stats` | iterate both accounts, applying `ours()` only where required |

### Webhook

```ts
for (const acct of ["astronaut", "leadoni"] as const) {
  try {
    return { event: await stripeFor(acct).webhooks.constructEventAsync(
      raw, sig, SECRETS[acct], undefined, cryptoProvider), account: acct };
  } catch { /* try the other */ }
}
return new Response("Bad signature", { status: 401 });
```

The account must be **threaded through**, never re-derived. `stripe-webhook`
calls `stripe.subscriptions.cancel(...)` during lifetime fulfilment; on the
wrong client that throws, firing the `lifetime_cancel_failed` 🚨 alert — the
customer holds lifetime *and* keeps being billed.

### Funnel

Swap `STRIPE_PUBLISHABLE_KEY` to astronaut's `pk_live_` in `quiz/a.html` and
`quiz2/index.html` (plus the `sss5/quiz.html` dev mirror). Both are
new-customer-only surfaces, so no dual handling is needed. `retention-offer`
and `create-story-pack-checkout` use hosted Checkout and need no client key.

**Still required from the user:** astronaut's `pk_live_` publishable key, its
secret key, and its webhook signing secret once the endpoint is registered.

## Cutover order

1. Migration (additive, safe to apply any time).
2. Deploy account-aware functions with `create-subscription` still pointed at
   **leadoni**. Nothing changes behaviourally; this proves the refactor in
   production against real traffic.
3. Register the webhook endpoint in astronaut, set `STRIPE_ASTRONAUT_*`
   secrets, redeploy.
4. Flip `create-subscription` to `astronaut` and swap the funnel publishable
   key.

Step 4 is deliberately the last and smallest change, with everything else
already proven live.

## Rollback

Point `create-subscription` back at leadoni and revert the funnel key. Anyone
already created on astronaut keeps working, because the routing column leaves
both accounts serviceable indefinitely. There is no state to unwind — that is
the main payoff of the explicit column over date-based routing.

## Verification

**No test-mode dry run** (user decision, 2026-08-08). Verification is against
live with a real card. That raises the stakes on the cutover order above:
step 2 exists precisely so the refactor is proven under real traffic while
`create-subscription` still points at leadoni, leaving step 4 as a one-line
flip.

- One real signup end-to-end on astronaut: checkout → webhook → `users` row
  with `stripe_account='astronaut'` → 🎉 Slack alert in `#sss-notifications`.
- On an existing leadoni customer: a cancel and a retention save-offer, proving
  the old path still routes correctly.
- A story-pack purchase on each account.
- `/stats-sss` shows combined figures with no double-counting.

## Noticed during the audit

**Fixed 2026-08-08 (commit `3d8c30f`), ahead of this work:** `/stats-sss` was
counting two subscriptions on leadoni's TEST 50c price as live customers. They
slipped through both existing guards — `ours()` accepts them because they carry
`metadata.session_id`, and `isFullyDiscounted()` misses them because they pay
real money ($0.50). They inflated active count, MRR and plan mix, and showed up
as the raw id `price_1Tire8KD4axecwd4N3hOVBOX×2`. Now excluded everywhere via
`isTestSub()`, keyed on `STRIPE_PRICE_TEST`. When astronaut goes live its own
test price must join that set, or the same distortion returns on the new
account.

**Still open, out of scope:** `PLAN_LABELS` in `slack-stats` maps only
`STRIPE_PRICE_1W/4W/8W`, ignoring `LITE` and `LIFETIME`, so those plans print
as raw ids or nicknames in the plan mix.
