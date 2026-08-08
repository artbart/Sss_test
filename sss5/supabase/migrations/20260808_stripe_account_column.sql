-- Which Stripe account bills this customer.
--
-- Defaulting to 'leadoni' means every pre-existing row is correct the moment
-- the column exists, so there is no backfill pass and no window where rows are
-- unrouted. Only new signups write 'astronaut'.
--
-- Additive only: no existing column or constraint is altered.
-- See docs/superpowers/specs/2026-08-08-stripe-dual-account-design.md

alter table public.users
  add column if not exists stripe_account text not null default 'leadoni';

alter table public.quiz_sessions
  add column if not exists stripe_account text not null default 'leadoni';

alter table public.quiz2_sessions
  add column if not exists stripe_account text not null default 'leadoni';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_stripe_account_check') then
    alter table public.users
      add constraint users_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz_sessions_stripe_account_check') then
    alter table public.quiz_sessions
      add constraint quiz_sessions_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'quiz2_sessions_stripe_account_check') then
    alter table public.quiz2_sessions
      add constraint quiz2_sessions_stripe_account_check
      check (stripe_account in ('leadoni','astronaut'));
  end if;
end $$;
