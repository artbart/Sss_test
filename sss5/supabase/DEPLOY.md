# Supabase deploy — Stuff So Sweet

This folder contains everything Supabase needs:

```
supabase/
├── config.toml                       (project_id + per-function jwt settings)
├── migrations/
│   └── 20260426_init.sql            (already applied via dashboard)
└── functions/
    ├── _shared/                      (helpers used by all functions)
    │   ├── anthropic.ts              (Claude Sonnet 4.6 wrapper)
    │   ├── cors.ts                   (CORS headers)
    │   ├── db.ts                     (Supabase admin client)
    │   ├── email_html.ts             (chapter email HTML/text builder)
    │   ├── parse.ts                  (parses Claude's labeled-field output)
    │   ├── prompts.ts                (chapter-1 + chapter-N prompt templates)
    │   └── resend.ts                 (email sender)
    ├── submit-quiz/index.ts          (POST from quiz.html)
    ├── submit-choice/index.ts        (POST from chapter.html)
    └── generate-chapter/index.ts     (internal — called by the other two)
```

## 1. Set environment variables

Go to **Project Settings → Edge Functions → Secrets** (or run via CLI as shown
below). Add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
| `RESEND_API_KEY` | your `re_...` key |
| `MAIL_FROM` | `stories@stuffsosweet.com` |
| `MAIL_FROM_NAME` | *(no longer required — display name is hardcoded to "Stuff So Sweet" in `_shared/resend.ts`)* |
| `MAIL_REPLY_TO` | `stories.stuffsosweet@gmail.com` |
| `CHAPTER_URL_BASE` | `https://stuffsosweet.com/chapter_update.html` |
| `SLACK_BOT_TOKEN` | `xoxb-...` Slack bot token (same bot reused from my-photo-alive) |
| `SLACK_CHANNEL_PURCHASES` | Channel ID (`C...`) for purchase/renewal/failure/cancel notifications. The bot must be invited to this channel. |
| `SLACK_SIGNING_SECRET` | Signing secret of the dedicated "SSS" Slack app (Basic Information). Unset ⇒ /stats returns 503. |
| `ACCOUNT_WEBHOOK_SECRET` | Random hex; must match the x-webhook-secret header baked into the users_account_created_webhook trigger. Rotate both together. |

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-provided by Supabase
and don't need to be set. `SLACK_*` are optional — the webhook no-ops the
notification if they're unset.)

## 2. Deploy the edge functions

Pick one path:

### Path A — Supabase CLI (recommended, ~2 minutes)

```bash
# 1. Install (Mac):
brew install supabase/tap/supabase

# 2. Authenticate:
supabase login --token <YOUR_PAT>          # the sbp_... token

# 3. From the repo root:
cd SSS5/sss5
supabase link --project-ref gmhbcxylqubhxozomhlt

# 4. Deploy all three functions:
supabase functions deploy submit-quiz
supabase functions deploy submit-choice
supabase functions deploy generate-chapter

# 5. Set the env vars (run once each):
supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
supabase secrets set RESEND_API_KEY=re_...
supabase secrets set MAIL_FROM=stories@stuffsosweet.com
supabase secrets set MAIL_FROM_NAME="Stuff So Sweet"
supabase secrets set MAIL_REPLY_TO=stories.stuffsosweet@gmail.com
supabase secrets set CHAPTER_URL_BASE=https://stuffsosweet.com/chapter_update.html
supabase secrets set SLACK_BOT_TOKEN=xoxb-...
supabase secrets set SLACK_CHANNEL_PURCHASES=C...   # invite the bot to this channel first
```

### Path B — Dashboard paste (no CLI)

For each of the three functions:

1. Open https://app.supabase.com/project/gmhbcxylqubhxozomhlt/functions
2. Click **Create a new function**
3. Name it exactly: `submit-quiz` (then `submit-choice`, then `generate-chapter`)
4. **For `submit-quiz` and `submit-choice`:** in the function settings, turn
   OFF "Verify JWT" (allow public POSTs from the quiz page).
   **For `generate-chapter`:** leave "Verify JWT" ON (only the service role
   should call it).
5. Paste the contents of the corresponding `index.ts` AND the `_shared/*.ts`
   files. The dashboard editor supports a multi-file structure: add each
   `_shared/*.ts` as a sibling file and the imports `"../_shared/foo.ts"`
   will resolve.
6. Click **Deploy**.

Then set the env vars in **Project Settings → Edge Functions → Secrets**
(same list as in Path A step 5).

## 3. Test the chain

1. Open https://stuffsosweet.com/quiz/a.html
2. Run through the funnel using **abobinas@gmail.com** (or your verified
   Resend account email — this is the only address Resend will deliver to
   until your domain is verified).
3. Click through to fake-payment.
4. Within ~30 seconds, Chapter 1 should arrive in your inbox.
5. Click one of the option buttons in the email — it'll open
   `chapter.html` which logs the click and triggers Chapter 2 generation.
6. Chapter 2 should arrive ~20 seconds later.

### Where to look if things break

- **Edge function logs:** https://app.supabase.com/project/gmhbcxylqubhxozomhlt/functions
  → click a function → "Logs" tab. Errors from Anthropic, Resend, or our
  parser show up here.
- **DB state:** https://app.supabase.com/project/gmhbcxylqubhxozomhlt/editor
  → look at `quiz_sessions` (did the row get created?), `stories`
  (status field tells the whole story), `chapters` (text + email_sent_at).
- **stories.last_error:** anything that bubbled up out of generate-chapter.
- **Browser console on quiz.html / chapter.html:** prefixed `[MHS quiz]`
  and `[MHS chapter]`.

## 4. Verify the Resend domain (when ready for real users)

Until you do this, only your account email gets emails.

1. https://resend.com/domains → **Add Domain** → `stuffsosweet.com`
2. Resend gives you 3 DNS records (TXT for SPF + DKIM + optional DMARC).
3. Add them in your DNS provider for stuffsosweet.com.
4. Wait for Resend to verify (usually a few minutes).
5. From then on, `stories@stuffsosweet.com` can send to anyone.

## Slack /stats + account-created alerts (one-time setup)

1. api.slack.com → Create App "SSS" → Slash Command `/stats` → request URL
   `https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/slack-stats` →
   Install to workspace. Copy Basic Information → Signing Secret into
   `SLACK_SIGNING_SECRET`.
2. Precondition: confirm the webhooks helper exists — in the SQL editor run
   `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'supabase_functions' and p.proname = 'http_request';`
   If it returns no rows, enable Database Webhooks once via Dashboard →
   Database → Webhooks (create + delete a dummy webhook), then re-check.
3. `supabase secrets set ACCOUNT_WEBHOOK_SECRET=<openssl rand -hex 32>`, then
   apply `migrations/20260720_account_created_webhook.sql` via the SQL editor
   with `__ACCOUNT_WEBHOOK_SECRET__` substituted for the same value (e.g. `sed
   "s/__ACCOUNT_WEBHOOK_SECRET__/$SECRET/" sss5/supabase/migrations/20260720_account_created_webhook.sql`).
   Never commit the real value.
4. Deploy `slack-stats` and `notify-account-created` with `--no-verify-jwt`.
5. Verify with `/stats` in Slack: `operation_timeout` ⇒ the ack/response_url
   async pattern is broken; `dispatch_failed` ⇒ wrong URL or unset secret.
   Also create a test account (fresh email, magic-link login) and confirm
   BOTH the 👤 Slack alert AND that a `public.users` row exists for it — the
   trigger fires inside the signup path, so this check protects against a
   repeat of the 2026-07-08 incident class.

---

## Retention save-flow + lifetime offer (2026-08-02)

Branch `feat/retention-save-flow`, spanning BOTH repos: `Sss_test` (migration +
edge functions) and `sss-app` (frontend). Nothing below has been executed —
the whole branch is reviewed, not tested.

**Run these in order. The ordering is load-bearing.**

### 1. Migration FIRST

```bash
supabase db push --project-ref gmhbcxylqubhxozomhlt
```

Adds `users.lifetime_at timestamptz` and `users.plan_tier text not null
default 'standard'` (CHECK: `standard` | `lite`). Strictly additive.

**Deploying the functions before this is a hard outage.** `resolveAccess`
selects the new columns; if they don't exist, the query errors, `lookupFailed`
is set, and all three story/chapter gates return 500 for every subscriber.
That's correct fail-closed behaviour, but it's total.

### 2. Verify two columns that could not be checked locally

`public.events` isn't in any migration (it was created directly in the
project), and the CLI isn't linked for `db` commands here, so these are
unverified assumptions in the code:

```sql
select column_name, data_type from information_schema.columns
 where table_schema = 'public' and table_name = 'events'
   and column_name in ('created_at', 'metadata');
```

- `created_at` — the offer-eligibility guard filters on it. If missing, the
  guard 500s and every offer accept shows "That didn't go through" while
  reason capture keeps working normally. Fails closed, but silently disables
  the offers. **If offers look dead but reasons are landing, check this first.**
- `metadata` should be `jsonb` — the reason-dedup reads `metadata->>'reason'`.
  If it's `text`, the dedup silently no-ops and `cancel_reason_selected` rows
  over-count again. Fails safe.

### 3. Stripe objects + secrets (LIVE mode)

The project uses a live `STRIPE_SECRET_KEY`, so test-mode ids will not work.
Create in the Stripe dashboard:

- Coupon, 50% off, **duration: once** → `STRIPE_COUPON_SAVE50`
- Recurring price, **$9.99 / 4 weeks** → `STRIPE_PRICE_LITE`
- One-time price, **$79.00** → `STRIPE_PRICE_LIFETIME`

```bash
supabase secrets set --project-ref gmhbcxylqubhxozomhlt \
  STRIPE_COUPON_SAVE50=<id> \
  STRIPE_PRICE_LITE=<id> \
  STRIPE_PRICE_LIFETIME=<id> \
  APP_URL=https://app.stuffsosweet.com
```

`APP_URL` must have **no trailing slash** (it is concatenated as
`${APP_URL}/settings.html`).

Until these are set the offer actions return 502 by design, and the frontend
shows "that didn't go through" with choices — it does **not** cancel the user.

### 4. Enable the webhook event

Add `checkout.session.completed` to the endpoint's enabled events.

**This is the most likely first-deploy failure and the app cannot detect it.**
Without it a customer pays $79, sees "Finalizing…" for ten minutes, and the
page then renders as though nothing happened. The Slack alert added in this
branch only fires on a grant that actually runs.

### 5. Deploy

```bash
supabase functions deploy \
  start-authenticated-story start-authenticated-story-v2 submit-choice \
  retention-offer stripe-webhook --project-ref gmhbcxylqubhxozomhlt
```

Note `start-authenticated-story-v2` also ships a reconciliation with the
deployed v5 — a production fix unrelated to this feature. The local copy had
gone stale and would have rejected every in-app quiz2 submission with
"Age confirmation required".

Frontend (`sss-app`) deploys via its own GitHub Pages flow.

### 6. Verify end to end, live mode

Walk all four branches with a real subscriber, then refund:

1. **too_expensive → discount** — Stripe shows the 50%-off coupon on the sub.
2. **too_expensive → decline → lifetime** — pay $79 with a real card.
   Confirm: `users.lifetime_at` set, subscription cancelled, Slack ping
   received, story creation still works, Settings shows the clean
   "Lifetime access — nothing to cancel" state. **Then refund.**
3. **not_using → pause** — `pause_collection.resumes_at` ~4 weeks out.
4. **not_using → decline → downgrade** — item on the $9.99 price and
   `users.plan_tier = 'lite'`.

Then build the PostHog funnel (project SSS, 207201):
`cancel_reason_selected` → `retention_offer_shown` → `retention_offer_accepted`,
broken down by `reason`.

### Operational notes — things with no automatic recovery

- **`plan_tier` has no reverse path.** Only the downgrade writes `'lite'`;
  only the lifetime grant writes `'standard'`. If you move someone off Lite in
  Stripe you MUST also update the column, or they keep 1 story/month at full
  price:
  ```sql
  update public.users set plan_tier = 'standard' where id = '<uuid>';
  ```
- **`pause` uses `behavior: "void"`** — a paused user keeps full access free
  for 4 weeks, and nothing is recorded in `users`. Support cannot see a pause
  without opening Stripe.
- **Three log-only failure paths on the money flow.** Grep the function logs
  for `CANCEL BY HAND`, `MANUAL GRANT REQUIRED`, and `FAILED TO RELEASE`.
  The first two now also page Slack; the third does not.
- **Reconciliation query** for a lifetime purchase that took money but never
  fulfilled:
  ```sql
  select * from public.events e
   where e.event_type = 'lifetime_checkout_started'
     and not exists (
       select 1 from public.events f
        where f.user_id = e.user_id and f.event_type = 'lifetime_purchased'
          and f.created_at > e.created_at)
     and e.created_at < now() - interval '1 hour';
  ```
