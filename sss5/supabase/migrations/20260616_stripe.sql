-- Stripe subscriptions: pre-signup mirror + idempotency + signup handoff
-- Strictly additive. Does NOT touch casp_notes or any unrelated table.
-- Applied to project gmhbcxylqubhxozomhlt on 2026-06-16 via Supabase migration "stripe_subscriptions".
-- quiz_sessions already has: email, plan, paid, payment_at, status

alter table public.quiz_sessions
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status    text,
  add column if not exists current_period_start   timestamptz,
  add column if not exists current_period_end      timestamptz,
  add column if not exists cancel_at_period_end     boolean not null default false;

create index if not exists quiz_sessions_stripe_customer_idx
  on public.quiz_sessions (stripe_customer_id);

-- webhook idempotency
create table if not exists public.stripe_events (
  id          text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;  -- service-role only, no policies

-- extend signup handoff to copy Stripe state from quiz_sessions -> users
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  qs public.quiz_sessions%rowtype;
begin
  select * into qs
  from public.quiz_sessions
  where email = NEW.email
  order by created_at desc
  limit 1;

  insert into public.users (
    id, email, notification_preference,
    stripe_customer_id, stripe_subscription_id, subscription_status,
    subscription_plan, current_period_start, current_period_end, cancel_at_period_end
  )
  values (
    NEW.id, NEW.email,
    coalesce(qs.notification_preference_choice, 'email_full_story'),
    qs.stripe_customer_id, qs.stripe_subscription_id,
    coalesce(qs.subscription_status, 'none'),
    qs.plan, qs.current_period_start, qs.current_period_end,
    coalesce(qs.cancel_at_period_end, false)
  )
  on conflict (id) do nothing;
  return NEW;
end;
$function$;
