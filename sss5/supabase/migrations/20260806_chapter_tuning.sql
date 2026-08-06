-- Chapter tuning: per-option modifier checkboxes.
--
-- Two additive columns on chapters:
--   next_options_modifiers  jsonb   -- modifiers the model generated for THIS chapter's next options
--     shape: { "1": ["mod a","mod b",...], "2": [...], "3": [...] }
--     read by chapter.html when rendering the option cards
--     written by generate-chapter-v2 after parsing the model's NEXT_OPTIONS_N_MODIFIERS sections
--   chosen_modifiers        text[]  -- modifiers the reader actually checked
--     written by submit-choice alongside chosen_option
--     read by generate-chapter-v2 on the NEXT chapter to compose the READER'S REQUESTED MODIFICATIONS prompt block
--
-- Both nullable / default null. Old chapters (created before this ships)
-- keep working — legacy rows show no toggle, next chapter runs without a
-- modifications block. Fully backwards-compatible.
--
-- No RLS changes needed — chapters already has correct policies.

alter table public.chapters
  add column if not exists next_options_modifiers jsonb,
  add column if not exists chosen_modifiers text[];

comment on column public.chapters.next_options_modifiers is
  'JSONB of {"1":[...],"2":[...],"3":[...]}. Modifiers the generation '
  'engine proposed for each next-chapter option. Rendered as checkboxes '
  'under each option card in chapter.html.';

comment on column public.chapters.chosen_modifiers is
  'Text array of the specific modifiers the reader checked when picking '
  'chosen_option. Persisted by submit-choice; read by generate-chapter-v2 '
  'on the next chapter to compose the READER\''S REQUESTED MODIFICATIONS '
  'prompt block. Empty/null = no modifiers = identical to today.';
