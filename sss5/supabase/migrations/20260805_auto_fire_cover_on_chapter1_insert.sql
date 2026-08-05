-- Fire generate-cover from a DB-level AFTER INSERT trigger on chapters.
-- Runs whenever chapter_number = 1 is inserted for a story that still has no
-- cover_image_url. Lives here (not in edge-function code) so it can't be
-- accidentally dropped by a future refactor.
--
-- Why DB trigger, not edge-function fire-and-forget:
--   The prior approach was to `fetch()` generate-cover from inside
--   generate-chapter / generate-chapter-v2 after inserting chapter 1. That
--   worked but had two failure modes we hit on 2026-08-05:
--     (a) if the edge function returns before the pending fetch flushes,
--         the Deno isolate can be killed mid-flight and the cover write
--         never lands, even though the HTTP call itself returned 200.
--     (b) if a future refactor drops the fetch(), covers silently stop
--         generating and it takes days to notice.
--   Putting this in the DB moves both risks to zero: the trigger is atomic
--   with the INSERT, and pg_net queues the request outside the transaction.
--
-- Safety:
--   • Only fires when chapter_number = 1
--   • Only fires when stories.cover_image_url IS NULL (idempotent)
--   • EXCEPTION handler ensures a cover-fire failure never breaks the
--     chapter insert itself
--   • generate-cover has its own force flag + storage-path idempotency, so
--     even a double-fire is safe.

CREATE OR REPLACE FUNCTION public.trigger_generate_cover_for_chapter1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_needs_cover boolean;
BEGIN
  IF NEW.chapter_number IS DISTINCT FROM 1 THEN
    RETURN NEW;
  END IF;

  SELECT (cover_image_url IS NULL)
    INTO v_needs_cover
    FROM public.stories
   WHERE id = NEW.story_id;

  IF v_needs_cover IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := 'https://gmhbcxylqubhxozomhlt.supabase.co/functions/v1/generate-cover',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- Public anon key (safe to embed; verify_jwt on generate-cover is off
      -- and the function is guarded by its own service-role writes).
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdtaGJjeHlscXViaHhvem9taGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxNTk5OTksImV4cCI6MjA5MjczNTk5OX0.GAM73P5X7fT1BIziTfvqUpFT2W_W5EtFb5Gze5cIFfY'
    ),
    body := jsonb_build_object('story_id', NEW.story_id::text),
    timeout_milliseconds := 60000
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'trigger_generate_cover_for_chapter1 fire failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS chapters_after_insert_generate_cover ON public.chapters;

CREATE TRIGGER chapters_after_insert_generate_cover
  AFTER INSERT ON public.chapters
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_generate_cover_for_chapter1();
