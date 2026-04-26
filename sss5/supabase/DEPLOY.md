# Supabase deploy — My Hidden Story

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
| `MAIL_FROM` | `stories@myhiddenstory.com` |
| `MAIL_FROM_NAME` | `My Hidden Story` |
| `MAIL_REPLY_TO` | `service.myhiddenstory@gmail.com` (optional) |
| `CHAPTER_URL_BASE` | `https://savageshopper.com/sss5/chapter.html` |

(`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are auto-provided by Supabase
and don't need to be set.)

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
supabase secrets set MAIL_FROM=stories@myhiddenstory.com
supabase secrets set MAIL_FROM_NAME="My Hidden Story"
supabase secrets set MAIL_REPLY_TO=service.myhiddenstory@gmail.com
supabase secrets set CHAPTER_URL_BASE=https://savageshopper.com/sss5/chapter.html
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

1. Open https://savageshopper.com/sss5/quiz.html
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

1. https://resend.com/domains → **Add Domain** → `myhiddenstory.com`
2. Resend gives you 3 DNS records (TXT for SPF + DKIM + optional DMARC).
3. Add them in your DNS provider for myhiddenstory.com.
4. Wait for Resend to verify (usually a few minutes).
5. From then on, `stories@myhiddenstory.com` can send to anyone.
