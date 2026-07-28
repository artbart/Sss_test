-- Quiz V2 schema — adds quiz2_sessions table + stories.quiz_version + stories.quiz2_session_id.
--
-- Purpose: run V2 quiz alongside V1 without touching V1 data or code paths. Every existing
-- stories row stays quiz_version=1 (via DEFAULT). New V2 stories carry quiz_version=2 and
-- reference quiz2_sessions instead of quiz_sessions. Version routing lives in stripe-webhook
-- and submit-choice (they dispatch to generate-chapter vs generate-chapter-v2 based on this
-- column). See SSS_V2_PLAN.md in the workspace for full architecture.
--
-- Applied to branch v2-dev (project_ref hurzryichqfpyzwewigx) first for testing.
-- Merged to main project (gmhbcxylqubhxozomhlt) only after V2 QA passes.
--
-- This migration is ADDITIVE ONLY. No existing V1 data or behaviour is affected.

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. quiz2_sessions — mirrors the V6 quiz spec (see quiz_draft_v6.html)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.quiz2_sessions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- Contact + funnel state (same shape as quiz_sessions)
  email                    text,
  email_captured_at        timestamptz,
  paid                     boolean NOT NULL DEFAULT false,
  payment_at               timestamptz,
  plan                     text,
  status                   text NOT NULL DEFAULT 'open',

  -- V2 quiz answers (field names mirror quiz_draft_v6.html)
  q0_age_confirmed         boolean NOT NULL DEFAULT false,

  q1_in_story              text CHECK (q1_in_story IN ('no','yes')),
  -- q1b compound: { name: string, gender: 'woman'|'man'|'nb' } | null
  q1b_you                  jsonb,

  q2_pairing               text CHECK (q2_pairing IN ('wm','ww','mm','queer','surprise')),

  q3_world                 text CHECK (q3_world IN (
    'contemporary','historical','fantasy_paranormal','monster','omegaverse','surprise'
  )),

  q4_love_interest         text CHECK (q4_love_interest IN (
    'brooding','protective','playful','ruthless','wounded','cinnamon','wildcard','surprise'
  )),

  q5_opening               text CHECK (q5_opening IN (
    'slow_build','meet_cute','already_ten','one_night','forced','fresh_start','surprise'
  )),

  q6_spicy                 text CHECK (q6_spicy IN ('sweet','spicy','very_spicy')),

  -- Multi-select mood chips (see prompts_v2.ts for chip→variable bundle mapping)
  q7_mood                  text[],

  -- Multi-select specifics (only populated when q8b_setup_depth = 'full')
  q8_specifics             text[],

  q8b_setup_depth          text CHECK (q8b_setup_depth IS NULL OR q8b_setup_depth IN ('quick','full')),

  -- Skip preferences (compound object with escape-hatch mutex + specifics + free text)
  -- Shape: { open_any: bool, specifics: text[], free_text: text }
  -- These override any conflicting picks upstream in the engine.
  q9_skip                  jsonb,

  -- Drill answers (only populated when q8b_setup_depth = 'full' AND relevant triggers)
  -- BDSM cluster
  d_restraint              text CHECK (d_restraint IS NULL OR d_restraint IN ('held','light','real','full')),
  d_sensory                text[],
  d_talk                   text[],
  d_aftercare              text CHECK (d_aftercare IS NULL OR d_aftercare IN ('warm','fed','quiet','playful','fade')),

  -- World cluster
  d_paranormal_kind        text[],
  d_monster_flavor         text[],
  d_omegaverse             text[],
  d_size                   text CHECK (d_size IS NULL OR d_size IN ('massive','significant','present','skip')),

  -- Multi-partner cluster
  d_partner_dynamic        text CHECK (d_partner_dynamic IS NULL OR d_partner_dynamic IN (
    'mutual','centered','two_plus_one','hierarchical','decide'
  )),

  -- Dark cluster
  d_dark_kind              text CHECK (d_dark_kind IS NULL OR d_dark_kind IN (
    'mafia','villain','stalker','captor','gray','full_villain'
  )),
  d_dark_consent           text CHECK (d_dark_consent IS NULL OR d_dark_consent IN (
    'fully','dubcon','cnc','skip'
  )),

  -- Voyeurism cluster
  d_voyeur                 text CHECK (d_voyeur IS NULL OR d_voyeur IN (
    'watched','watching','mutual','someone_else','risk_only'
  )),

  -- Attribution + UTM (same shape as quiz_sessions)
  fbclid                   text,
  fbc                      text,
  funnel_version           text,
  landing_page             text,
  user_agent               text,
  device_type              text,

  -- Delivery preference chosen on the success page (same as V1)
  notification_preference_choice text DEFAULT 'email_link_only' CHECK (
    notification_preference_choice IN ('email_full_story','email_link_only','in_app_only')
  ),

  -- Stripe mirror (populated by stripe-webhook, exactly like quiz_sessions)
  stripe_customer_id       text,
  stripe_subscription_id   text,
  subscription_status      text,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean DEFAULT false
);

COMMENT ON TABLE public.quiz2_sessions IS
  'V2 quiz submissions (Quiz V6 spec — see quiz_draft_v6.html). Runs alongside V1 quiz_sessions. See SSS_V2_PLAN.md for full architecture.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Indexes on quiz2_sessions
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE INDEX quiz2_sessions_email_lower_idx
  ON public.quiz2_sessions (lower(email));

CREATE INDEX quiz2_sessions_paid_idx
  ON public.quiz2_sessions (paid) WHERE paid = true;

CREATE INDEX quiz2_sessions_stripe_customer_idx
  ON public.quiz2_sessions (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

CREATE INDEX quiz2_sessions_created_at_idx
  ON public.quiz2_sessions (created_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. RLS on quiz2_sessions (same pattern as quiz_sessions)
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.quiz2_sessions ENABLE ROW LEVEL SECURITY;

-- Anon can insert (marketing site submits quiz answers as anon user)
CREATE POLICY quiz2_sessions_insert_anon ON public.quiz2_sessions
  FOR INSERT TO anon
  WITH CHECK (true);

-- Service role has full access (Edge Functions use service_role)
CREATE POLICY quiz2_sessions_service_role_all ON public.quiz2_sessions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. updated_at trigger on quiz2_sessions
-- ═══════════════════════════════════════════════════════════════════════════════

-- Reuse the existing trigger function from V1 if present, otherwise create ours.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'trigger_set_updated_at') THEN
    CREATE FUNCTION public.trigger_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql AS $fn$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $fn$;
  END IF;
END $$;

CREATE TRIGGER quiz2_sessions_set_updated_at
  BEFORE UPDATE ON public.quiz2_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. stories table additions — quiz_version routing
-- ═══════════════════════════════════════════════════════════════════════════════

-- Existing rows all get quiz_version=1 via DEFAULT. New V2 stories will set =2.
ALTER TABLE public.stories
  ADD COLUMN quiz_version      smallint NOT NULL DEFAULT 1,
  ADD COLUMN quiz2_session_id  uuid REFERENCES public.quiz2_sessions(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.stories.quiz_version IS
  'Which quiz version generated this story. 1 = V1 (quiz_sessions), 2 = V2 (quiz2_sessions). Used by stripe-webhook, submit-choice, generate-chapter to route to correct engine.';

COMMENT ON COLUMN public.stories.quiz2_session_id IS
  'FK to quiz2_sessions for V2 stories. NULL for V1 stories (which use session_id → quiz_sessions instead).';

CREATE INDEX stories_quiz_version_idx
  ON public.stories (quiz_version);

CREATE INDEX stories_quiz2_session_id_idx
  ON public.stories (quiz2_session_id) WHERE quiz2_session_id IS NOT NULL;

-- Sanity check: no V1 story has quiz2_session_id populated.
ALTER TABLE public.stories
  ADD CONSTRAINT stories_v1_no_quiz2_ref
  CHECK (quiz_version <> 1 OR quiz2_session_id IS NULL);

-- V2 stories use quiz2_session_id and set session_id NULL. Loosen the old NOT NULL
-- on session_id so this is possible, then add symmetric CHECKs enforcing that:
--   V1 → session_id IS NOT NULL
--   V2 → quiz2_session_id IS NOT NULL
-- (Caught by smoke test: without this, V2 story insert fails on NOT NULL constraint.)
ALTER TABLE public.stories ALTER COLUMN session_id DROP NOT NULL;

ALTER TABLE public.stories
  ADD CONSTRAINT stories_v1_has_session_ref
  CHECK (quiz_version <> 1 OR session_id IS NOT NULL);

ALTER TABLE public.stories
  ADD CONSTRAINT stories_v2_has_quiz2_ref
  CHECK (quiz_version <> 2 OR quiz2_session_id IS NOT NULL);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Verification queries (run these after apply to sanity-check)
-- ═══════════════════════════════════════════════════════════════════════════════

-- SELECT count(*) FROM public.quiz2_sessions;                          -- should be 0
-- SELECT quiz_version, count(*) FROM public.stories GROUP BY 1;         -- all rows should show quiz_version=1
-- SELECT count(*) FROM public.stories WHERE quiz2_session_id IS NOT NULL;  -- should be 0
