-- Story pack top-up: lifetime credits ledger on users.
--
-- Model: each $4.99 pack purchase adds 3 to extra_story_credits (via
-- stripe-webhook checkout.session.completed handler). Credits are lifetime —
-- they don't reset monthly; unused ones roll over indefinitely.
--
-- Quota check (in start-authenticated-story-v2):
--   used_this_month = count(stories created this month)
--   base_limit      = storyLimitFor(plan_tier)              -- 3 std / 1 lite
--   effective_limit = base_limit + extra_story_credits
--   allowed if:  used_this_month < effective_limit
--
-- On story insert past base_limit: decrement extra_story_credits by 1
-- (atomically, via UPDATE ... WHERE extra_story_credits > 0).
--
-- Unlimited stacking is the design intent — a user who blows through 6, buys
-- another pack, gets 9. No cap.

alter table public.users
  add column if not exists extra_story_credits int not null default 0;

-- Guard against negative values from any future subtract-past-zero bug.
alter table public.users
  add constraint users_extra_story_credits_nonneg
  check (extra_story_credits >= 0);

comment on column public.users.extra_story_credits is
  'Lifetime story credits from $4.99 3-pack top-ups. Each pack += 3. '
  'Decremented by start-authenticated-story-v2 when a story is created past '
  'the plan_tier base monthly limit. Never resets automatically.';
