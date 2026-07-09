-- Make the signup handoff fail-safe. Applied to project gmhbcxylqubhxozomhlt
-- on 2026-07-09 via Supabase migration "harden_handle_new_auth_user".
--
-- Background: payment happens BEFORE the account exists, so a paying customer's
-- FIRST magic-link login is what creates their auth.users row and fires this
-- trigger. The previous version copied quiz_sessions values straight into
-- public.users; a messy funnel row (double charge, abandoned attempt, mixed-case
-- email) could violate a constraint, roll back the auth.users insert, and make
-- GoTrue return "Database error saving new user" — locking the paid user out.
--
-- Real incident (robbiecranfilljr@yahoo.com, 2026-07-08): a double charge left
-- an 'incomplete_expired' quiz_sessions row; the case-SENSITIVE email match
-- picked it over the paid 'active' row, and users_subscription_status_check
-- rejected 'incomplete_expired'. Login failed on every attempt.
--
-- This version: case-insensitive email match, prefer the paid session, clamp
-- subscription_status to the allowed set, avoid the UNIQUE(stripe_customer_id)
-- collision, and wrap the insert so profile-seeding can NEVER abort the auth
-- insert. Strictly replaces the function; touches no tables.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  qs public.quiz_sessions%rowtype;
  v_status   text;
  v_customer text;
begin
  -- Case-insensitive match (auth stores email lowercased; funnel rows may be
  -- mixed-case). Prefer a PAID session, then the most recent, so double-charge
  -- / abandoned 'incomplete_*' rows never outrank the real purchase.
  select * into qs
  from public.quiz_sessions
  where lower(email) = lower(NEW.email)
  order by paid desc nulls last, created_at desc
  limit 1;

  -- Clamp to the users_subscription_status_check set; anything else -> 'none'.
  v_status := coalesce(qs.subscription_status, 'none');
  if v_status not in ('none','trialing','active','past_due','canceled','paused') then
    v_status := 'none';
  end if;

  -- Respect UNIQUE(stripe_customer_id): drop it if already attached to another
  -- users row. The stripe-webhook re-syncs billing state by customer id later.
  v_customer := qs.stripe_customer_id;
  if v_customer is not null and exists (
    select 1 from public.users where stripe_customer_id = v_customer
  ) then
    v_customer := null;
  end if;

  begin
    insert into public.users (
      id, email, notification_preference,
      stripe_customer_id, stripe_subscription_id, subscription_status,
      subscription_plan, current_period_start, current_period_end, cancel_at_period_end
    )
    values (
      NEW.id, NEW.email,
      coalesce(qs.notification_preference_choice, 'email_full_story'),
      v_customer, qs.stripe_subscription_id, v_status,
      qs.plan, qs.current_period_start, qs.current_period_end,
      coalesce(qs.cancel_at_period_end, false)
    )
    on conflict (id) do nothing;
  exception when others then
    -- Never let profile seeding block account creation. Fall back to a bare
    -- row (all other columns have safe defaults, incl. subscription_status
    -- 'none'); webhook fills in billing state by stripe_customer_id.
    raise warning 'handle_new_auth_user: full seed failed for % (% %); inserting minimal row',
      NEW.email, sqlstate, sqlerrm;
    begin
      insert into public.users (id, email)
      values (NEW.id, NEW.email)
      on conflict (id) do nothing;
    exception when others then
      raise warning 'handle_new_auth_user: minimal seed also failed for % (% %)',
        NEW.email, sqlstate, sqlerrm;
    end;
  end;

  return NEW;
end;
$function$;
