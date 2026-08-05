-- Chapter ratings — 1-10 stars + optional text, one shot per user per chapter.
--
-- No updates allowed by design (see RLS policy). Once a reader rates a
-- chapter, that's the rating. Rationale: we want raw first-impression signal
-- for prompt tuning, not curated re-rates.
--
-- Feeds the "SSS Generation Health" report (avg by chapter number, worst
-- chapters + their feedback text, response rate over time).

create table if not exists public.chapter_ratings (
  id             uuid primary key default gen_random_uuid(),
  chapter_id     uuid not null references public.chapters(id) on delete cascade,
  user_id        uuid not null references auth.users(id) on delete cascade,
  story_id       uuid not null references public.stories(id) on delete cascade,
  chapter_number int  not null,
  stars          int  not null check (stars between 1 and 10),
  feedback_text  text,
  created_at     timestamptz not null default now(),
  unique (chapter_id, user_id)
);

-- Helpful indexes for the reporting queries
create index if not exists chapter_ratings_chapter_number_idx
  on public.chapter_ratings (chapter_number);
create index if not exists chapter_ratings_story_id_idx
  on public.chapter_ratings (story_id);
create index if not exists chapter_ratings_created_at_idx
  on public.chapter_ratings (created_at desc);

alter table public.chapter_ratings enable row level security;

-- User can read own ratings (so widget can show "you rated this")
create policy "chapter_ratings: select own"
  on public.chapter_ratings for select
  using (auth.uid() = user_id);

-- User can insert a rating for themselves. No update policy — enforced at
-- DB layer, not just UI, so a manipulated client can't overwrite.
create policy "chapter_ratings: insert own"
  on public.chapter_ratings for insert
  with check (auth.uid() = user_id);

-- Service role (reports) bypasses RLS anyway; no dedicated report policy.
