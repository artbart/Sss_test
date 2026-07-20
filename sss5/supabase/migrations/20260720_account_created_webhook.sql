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
