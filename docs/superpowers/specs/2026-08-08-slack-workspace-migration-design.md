# Slack workspace migration — design

Date: 2026-08-08
Supersedes the workspace/credential assumptions in
`2026-07-20-slack-business-alerts-design.md`. The alert *behaviour* designed
there is unchanged; only where it lands moves.

## Goal

Move every SSS Slack surface off the current workspace (the one whose bot is
shared with my-photo-alive) onto a different Slack workspace and channel.

## Context / what exists today

Two independent Slack surfaces, both on the old workspace:

1. **Outbound alerts.** `sss5/supabase/functions/_shared/slack.ts` posts to
   `chat.postMessage` using `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_PURCHASES`.
   Imported by `stripe-webhook` and `notify-account-created`. Eight alert
   kinds: `purchase`, `renewal`, `payment_failed`, `cancellation`,
   `cancel_scheduled`, `account_created`, `lifetime_purchase`,
   `lifetime_cancel_failed`.
2. **Inbound `/stats`.** The "SSS" Slack app's slash command hits
   `slack-stats`, authenticated by HMAC against `SLACK_SIGNING_SECRET`.

Secrets live on Supabase project `gmhbcxylqubhxozomhlt`. `SLACK_BOT_TOKEN` and
`SLACK_CHANNEL_PURCHASES` were set 2026-06-18; `SLACK_SIGNING_SECRET`
2026-07-20.

## Scope (user-approved)

- Move **both** surfaces — alerts and `/stats`.
- **One channel** in the new workspace for all eight alert kinds. Straight
  port of current behaviour.
- Nothing else about the alerts changes: same trigger points, same message
  format, same fire-and-forget semantics.

Out of scope: splitting alerts across channels, dual-sending to both
workspaces during a transition, any change to alert content or triggers.

## Decisions made during brainstorming

- **No code change.** `slack.ts` reads both values from `Deno.env`; the
  migration is a credential + destination swap. Considered and rejected: a
  dual-send transition period (Approach B) — these alerts are non-critical and
  self-verifying, so the extra code on a fire-and-forget path isn't earned.
- **Clean cutover, not gradual.** Rollback is re-setting the secrets and
  redeploying, not a feature flag.
- **The function URL does not change.** `/stats` in the new workspace points
  at the same
  `https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats`. Only
  *who may call it* changes, via the new signing secret.
- **A NEW Slack app, not the existing "SSS" app.** Considered and rejected:
  reusing the current app by activating public distribution and installing it
  into the new workspace. A Slack app is owned by its creating workspace, so
  this needs the distribution checklist (or a shared Enterprise Grid org,
  which does not apply here). Worse, the signing secret and the slash-command
  request URL are *app-level* — shared by every install — so a reused app left
  installed in the old workspace keeps serving `/stats` there, exposing MRR,
  revenue and churn to the workspace we are leaving. Removing the `/stats`
  command to stop that would disable it in the new workspace too; the old
  *install* would have to be deleted as a separate, easy-to-forget step. A new
  app severs the old workspace by construction. Its only cost is one extra
  `secrets set` in a cutover already swapping two other values.

## Invariants (must survive the migration)

- **The old bot token must NOT be revoked.** `DEPLOY.md:37` records it as the
  same bot reused from the my-photo-alive setup. SSS stops *using* it; that
  product keeps depending on it. Revoking is the one genuinely destructive
  action available in this migration.
- **`notify-account-created` and `slack-stats` deploy with
  `--no-verify-jwt`** (`DEPLOY.md:149`). Redeploying either without the flag
  breaks the endpoint: the database webhook and Slack both call unauthenticated.
- **Alert notifiers never throw.** Nothing in this migration may make
  fulfilment depend on a notification succeeding.

## Why a redeploy is required, not just `secrets set`

`slack.ts:11-12` captures `TOKEN` and `CHANNEL` in top-level `const`s,
evaluated once when the edge worker boots. A warm worker keeps the old values
until it is recycled. Redeploying forces a fresh boot, which makes the cutover
deterministic — and makes "not yet recycled" distinguishable from
"misconfigured" during verification.

## Plan

### Phase 1 — Build the new Slack app (manual, in the Slack UI)

In the new workspace: create app "SSS"; bot scopes `chat:write` and
`commands`; slash command `/stats` → the unchanged function URL above; install
to workspace; create or pick the target channel and **invite the bot to it**.

Collect three values: `xoxb-` bot token, signing secret (Basic Information),
channel ID (`C…`).

The app must be fully installed and the bot invited *before* Phase 3, so there
is no window where alerts land nowhere.

### Phase 2 — Pre-flight drift check

`supabase functions download` for `stripe-webhook`, `notify-account-created`,
`slack-stats`; diff against `sss5/supabase/functions/`. Deployed versions may
be ahead of this tree. If any file differs, stop and reconcile before
redeploying — a blind redeploy would revert deployed work.

### Phase 3 — Cutover

Capture the current secret values first if they can still be revealed (the CLI
returns hashes, so this may require the Supabase dashboard). Then overwrite on
`gmhbcxylqubhxozomhlt`:

- `SLACK_BOT_TOKEN` → new `xoxb-`
- `SLACK_CHANNEL_PURCHASES` → new `C…`
- `SLACK_SIGNING_SECRET` → new signing secret

Redeploy `stripe-webhook`, `notify-account-created` (`--no-verify-jwt`),
`slack-stats` (`--no-verify-jwt`).

### Phase 4 — Verify

- Run `/stats` in the new workspace. Real numbers ⇒ signing secret and command
  URL are correct. `dispatch_failed` ⇒ wrong URL; 503 ⇒ secret unset;
  `operation_timeout` ⇒ the ack/`response_url` path broke.
- Trigger one real alert: create a test account with a fresh email via magic
  link. Confirm the 👤 `account_created` message arrives in the new channel
  **and** that a `public.users` row exists for it. This doubles as a re-check
  of the 2026-07-08 incident class (auth trigger coupled to signup).
- Confirm the old workspace channel goes silent.

### Phase 5 — Docs and cleanup

- Update `sss5/supabase/DEPLOY.md:37-39`: drop the "same bot reused from
  my-photo-alive" note and point the Slack setup section at the new workspace.
- Delete the old app's `/stats` slash command. It would 401 against the new
  signing secret; a removed command beats a silently broken one.
- Leave the old bot token active (see Invariants).

## Failure modes

- **Bot not invited to the channel** — `chat.postMessage` returns
  `not_in_channel`; `slack.ts:83` only `console.error`s it. Alerts vanish
  silently with no user-visible signal. This is why Phase 4 verifies a real
  alert rather than assuming the secret swap worked.
- **Missing `chat:write` scope** — same silent-failure shape, different error
  string in the function logs.
- **Redeploy without `--no-verify-jwt`** — `/stats` and the account-created
  webhook start returning 401.

## Rollback

Re-set the three secrets to their old values and redeploy the same three
functions. If the old values cannot be revealed from the dashboard, rollback
degrades to re-running Phase 1 against the old workspace — recoverable, but
manual. Capture the old values in Phase 3 to avoid this.

## Verification checklist

- [ ] `/stats` returns real numbers in the new workspace
- [ ] `account_created` alert lands in the new channel, and the `public.users`
      row exists for the test email
- [ ] Old workspace channel receives nothing
- [ ] Old bot token still valid (my-photo-alive unaffected)
- [ ] `DEPLOY.md` no longer describes the old workspace
