# Per-workspace `/stats` — design

Date: 2026-08-08
Builds on [2026-08-08-stripe-dual-account-design.md](2026-08-08-stripe-dual-account-design.md).

## Goal

Each Slack workspace sees the Stripe account it owns:

| Slack workspace | Slash command | Reports on |
|---|---|---|
| Astronautai | `/stats-sss` | `astronaut` |
| MPA | `/stats` | `leadoni` |

Either workspace can still get the combined view with the `all` argument.

## Relationship to the dual-account work

The dual-account plan's Task 8 made `gatherStatsText()` walk both accounts and
sum them into one report. That is not undone — the per-account loop *is* the
mechanism this design needs. Only the caller changes: it now passes a list of
accounts to report on, rather than the loop always covering both.

## Routing — identical shape to the webhook

A Slack slash command is authenticated by a **workspace-specific signing
secret**, so the secret that verifies a request identifies the workspace it
came from. This is the same trick `stripe-webhook` uses to identify the Stripe
account an event came from.

| Env var | Workspace | Stripe account |
|---|---|---|
| `SLACK_SIGNING_SECRET` (existing, unchanged) | Astronautai | `astronaut` |
| `SLACK_MPA_SIGNING_SECRET` (new) | MPA | `leadoni` |

Additive, matching the `STRIPE_ASTRONAUT_*` pattern: nothing that works today
is renamed.

**`team_id` cannot be used instead.** The slash payload carries it, but no
field in the body may be trusted before the signature is verified — and
verifying requires already knowing which secret to use. The secret is the
identity; `team_id` is only a claim.

## Design

- `validSignature()` becomes a loop over configured workspace secrets,
  returning the matched `StripeAccount` or `null`. Unmatched ⇒ 401, as today.
- `gatherStatsText(accounts: StripeAccount[])` reports on the accounts given.
  A workspace request passes one; `all` passes both.
- The `text` field of the slash payload, trimmed and lowercased, selects the
  combined report when it equals `"all"`.
- Each report's header names its scope — `📊 Stuff So Sweet — astronaut`,
  `— leadoni`, `— all accounts` — so nobody misreads which numbers they see.

### Leads and conversion (user decision)

Leads live in `quiz_sessions` and are captured **before** any payment, so they
belong to no Stripe account. Rendering them in both reports would show the same
number twice, and — worse — `lead→paid conversion = newSubs ÷ leads` would
divide one account's subscribers by SSS-wide leads.

Decision: **leads and conversion appear only in the astronaut report**, always,
regardless of where `create-subscription` currently points. The leadoni report
omits both lines.

Known consequence, accepted: astronaut has zero subscribers until the Stripe
cutover, so conversion would read `0.0%`. **Guard:** when the reported accounts
have no new subs in a window, conversion prints `n/a` rather than `0.0%` —
consistent with the existing `pct()` convention, which already returns `n/a`
instead of dividing by zero. It self-corrects once signups move to astronaut.

## No Slack-side changes

MPA's `/stats` already targets the same function URL, and slash commands reply
via `response_url`, which needs neither bot membership nor extra scopes. So no
app reinstall, no new channel, no `/invite`. The only input required is that
app's existing signing secret.

## Failure modes

- **`SLACK_MPA_SIGNING_SECRET` unset** — MPA's `/stats` keeps returning 401
  exactly as it does today. No new breakage while the secret is being fetched.
- **Request signed by neither secret** — 401, unchanged.
- **After the Stripe cutover**, MPA's report shows a shrinking book: leadoni
  gets no new subscribers, only renewals, cancels and refunds from the existing
  base. That is the correct picture of a wind-down, not a bug.

## Verification

- `/stats-sss` in Astronautai returns astronaut figures with leads and
  conversion present.
- `/stats` in MPA returns leadoni figures with no leads or conversion lines.
- `/stats-sss all` returns the combined report.
- A request with a bad signature still returns 401.
