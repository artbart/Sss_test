-- Retention save-flow: lifetime entitlement + plan tiers.
-- Strictly additive. Does NOT touch casp_notes or any unrelated table.
-- Target project: gmhbcxylqubhxozomhlt

alter table public.users
  add column if not exists lifetime_at timestamptz,
  add column if not exists plan_tier   text not null default 'standard';

-- Only two tiers exist today. Guard against typos writing a tier that
-- storyLimitFor() would silently treat as 'standard'.
alter table public.users
  drop constraint if exists users_plan_tier_check;
alter table public.users
  add constraint users_plan_tier_check
  check (plan_tier in ('standard', 'lite'));

create index if not exists users_lifetime_at_idx
  on public.users (lifetime_at)
  where lifetime_at is not null;
