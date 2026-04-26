// POST /functions/v1/generate-chapter   (verify_jwt = true; service-role only)
//
// Internal endpoint, called by submit-quiz (target=1) and submit-choice (target=N+1).
//
// Body:
//   { story_id: uuid, target_chapter_number: number }
//
// Behavior:
//   - For chapter 1: load quiz_session, build chapter-1 prompt, call Claude,
//     parse, save story metadata + chapters row 1, send email.
//   - For chapter N+1: load story state + previous chapter (with chosen option),
//     build chapter-N prompt, call Claude, parse, save chapters row N, update
//     story state, send email.
//
// On parse error or AI failure, we record the error on stories.last_error and
// status='error' so we can inspect / retry.

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { callClaude } from "../_shared/anthropic.ts";
import { sendEmail } from "../_shared/resend.ts";
import { parseLabeled } from "../_shared/parse.ts";
import { buildChapterEmail } from "../_shared/email_html.ts";
import {
  chapter1Prompt, chapterNPrompt,
  type QuizContext, type ChapterNContext,
} from "../_shared/prompts.ts";

const CHAPTER_URL_BASE =
  Deno.env.get("CHAPTER_URL_BASE") ?? "https://savageshopper.com/sss5/chapter.html";

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { story_id?: string; target_chapter_number?: number };
  try { body = await req.json(); }
  catch (_) { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const storyId = (body.story_id ?? "").trim();
  const target = Number(body.target_chapter_number);
  if (!storyId || !Number.isInteger(target) || target < 1) {
    return jsonResponse({ error: "Missing or invalid story_id / target_chapter_number" }, 400);
  }

  const db = adminClient();

  // Idempotency: if the chapter already exists, just no-op.
  const { data: existing } = await db
    .from("chapters")
    .select("id")
    .eq("story_id", storyId)
    .eq("chapter_number", target)
    .maybeSingle();
  if (existing) {
    return jsonResponse({ ok: true, skipped: "chapter already exists" });
  }

  // Load story + (if needed) session and previous chapter.
  const { data: story, error: storyErr } = await db
    .from("stories")
    .select("*")
    .eq("id", storyId)
    .maybeSingle();
  if (storyErr || !story) {
    return jsonResponse({ error: "story not found" }, 404);
  }

  try {
    if (target === 1) {
      await generateChapterOne(db, story);
    } else {
      await generateChapterN(db, story, target);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("generate-chapter failed:", msg);
    await db
      .from("stories")
      .update({ status: "error", last_error: msg.slice(0, 4000) })
      .eq("id", storyId);
    return jsonResponse({ error: msg }, 500);
  }
});


// ===================================================================
// Chapter 1
// ===================================================================
async function generateChapterOne(db: ReturnType<typeof adminClient>, story: any) {
  // Load quiz session for the prompt context.
  const { data: session, error: sErr } = await db
    .from("quiz_sessions")
    .select("*")
    .eq("id", story.session_id)
    .single();
  if (sErr || !session) throw new Error(`session not found for story ${story.id}`);

  const quiz: QuizContext = {
    partner_preference:    session.q_character,
    scene_mood:            session.q_feeling,
    fantasy_core:          session.q_fantasy,
    power_dynamic:         session.q_power,
    emotional_pacing:      session.q_emotion,
    relationship_setup:    session.q_start,
    personal_need:         session.q_missing,
    romance_type:          session.q_romance_type,
    story_experience:      session.q_experience,
    why_now:               session.q_reason,
    reader_pull_factors:   Array.isArray(session.q_spicy_trigger)
                             ? session.q_spicy_trigger.join(", ")
                             : session.q_spicy_trigger,
    emotional_intensity_ok: session.q_intense,
    explicit_ok:           session.q_explicit,
    open_to_variety:       session.q_explore,
    relationship_status:   session.q_relationship,
  };

  const prompt = chapter1Prompt(quiz, story.target_chapter_count ?? 10);
  const raw = await callClaude({ user: prompt });
  const parsed = parseLabeled(raw);

  if (!parsed.ok) {
    throw new Error(`AI returned error: ${parsed.errorReason ?? "unknown"}; raw[0..200]=${raw.slice(0, 200)}`);
  }
  const f = parsed.fields;

  // Validate the must-have fields
  for (const k of ["CHAPTER_1_TEXT", "STORY_TITLE", "NEXT_OPTIONS_1", "NEXT_OPTIONS_2", "NEXT_OPTIONS_3"]) {
    if (!f[k]) throw new Error(`AI output missing field: ${k}`);
  }

  // Update story with metadata + state.
  const newState = {
    global_summary:      f.GLOBAL_SUMMARY ?? null,
    story_bible_summary: f.STORY_BIBLE_SUMMARY ?? null,
    world_rules:         f.WORLD_RULES ?? null,
    world_state:         f.WORLD_STATE ?? null,
    character_state:     f.CHARACTER_STATE ?? null,
    relationship_map:    f.RELATIONSHIP_MAP ?? null,
    timeline_state:      f.TIMELINE_STATE ?? null,
    open_loops:          f.OPEN_LOOPS ?? null,
    resolved_loops:      f.RESOLVED_LOOPS ?? null,
    items_of_importance: f.ITEMS_OF_IMPORTANCE ?? null,
    secrets_and_reveals: f.SECRETS_AND_REVEALS ?? null,
  };

  await db.from("stories").update({
    status:                  "active",
    current_chapter_number:  1,
    title:                   f.STORY_TITLE,
    genre:                   f.STORY_GENRE,
    tone_label:              f.TONE_LABEL,
    heat_level:              f.HEAT_LEVEL,
    setting_type:            f.SETTING_TYPE,
    fantasy_type:            f.FANTASY_TYPE,
    relationship_dynamic:    f.RELATIONSHIP_DYNAMIC,
    character_archetype:     f.CHARACTER_ARCHETYPE,
    hook:                    f.STORY_HOOK,
    opening_premise:         f.OPENING_PREMISE,
    original_setup:          f.ORIGINAL_SETUP,
    state:                   newState,
    last_error:              null,
  }).eq("id", story.id);

  // Insert chapter 1 row.
  await db.from("chapters").insert({
    story_id:                  story.id,
    chapter_number:            1,
    text:                      f.CHAPTER_1_TEXT,
    summary:                   f.CHAPTER_1_SUMMARY,
    mood:                      f.CHAPTER_1_MOOD,
    key_event:                 f.CHAPTER_1_KEY_EVENT,
    closure_hook:              f.CHAPTER_1_CLOSURE_HOOK,
    next_chapter_goal:         f.NEXT_CHAPTER_GOAL,
    next_chapter_arc_position: f.NEXT_CHAPTER_ARC_POSITION,
    next_chapter_tone_hint:    f.NEXT_CHAPTER_TONE_HINT,
    next_chapter_stakes_level: f.NEXT_CHAPTER_STAKES_LEVEL,
    option_1:                  f.NEXT_OPTIONS_1,
    option_2:                  f.NEXT_OPTIONS_2,
    option_3:                  f.NEXT_OPTIONS_3,
  });

  // Send email.
  await sendChapterEmail(db, story.id, 1, story.lead_email, f.STORY_TITLE,
    f.CHAPTER_1_TEXT, [f.NEXT_OPTIONS_1, f.NEXT_OPTIONS_2, f.NEXT_OPTIONS_3]);
}


// ===================================================================
// Chapter N (>= 2)
// ===================================================================
async function generateChapterN(db: ReturnType<typeof adminClient>, story: any, n: number) {
  // Load previous chapter (n-1) to get the user's pick + carry-over context.
  const { data: prev, error: prevErr } = await db
    .from("chapters")
    .select("*")
    .eq("story_id", story.id)
    .eq("chapter_number", n - 1)
    .single();
  if (prevErr || !prev) throw new Error(`prev chapter ${n - 1} not found`);
  if (!prev.chosen_option) throw new Error(`prev chapter ${n - 1} has no chosen_option`);

  const chosenText =
    prev.chosen_option === 1 ? prev.option_1 :
    prev.chosen_option === 2 ? prev.option_2 :
                               prev.option_3;
  if (!chosenText) throw new Error(`prev chapter option_${prev.chosen_option} text is empty`);

  const s = (story.state ?? {}) as Record<string, string | null>;

  const ctx: ChapterNContext = {
    chapterNumber: n,
    storyMetadata: {
      genre:     story.genre,
      tone:      story.tone_label,
      heat:      story.heat_level,
      setting:   story.setting_type,
      fantasy:   story.fantasy_type,
      dynamic:   story.relationship_dynamic,
      archetype: story.character_archetype,
    },
    globalSummary:    s.global_summary    ?? undefined,
    worldState:       s.world_state       ?? undefined,
    characterState:   s.character_state   ?? undefined,
    relationshipMap:  s.relationship_map  ?? undefined,
    timelineState:    s.timeline_state    ?? undefined,
    openLoops:        s.open_loops        ?? undefined,
    prevChapter: {
      summary:      prev.summary       ?? undefined,
      mood:         prev.mood          ?? undefined,
      keyEvent:     prev.key_event     ?? undefined,
      closureHook:  prev.closure_hook  ?? undefined,
    },
    userChoiceText: chosenText,
    nextIntent: {
      goal:         prev.next_chapter_goal         ?? undefined,
      arcPosition:  prev.next_chapter_arc_position ?? undefined,
      toneHint:     prev.next_chapter_tone_hint    ?? undefined,
      stakesLevel:  prev.next_chapter_stakes_level ?? undefined,
    },
  };

  const prompt = chapterNPrompt(ctx);
  const raw = await callClaude({ user: prompt, maxTokens: 6000 });
  const parsed = parseLabeled(raw);
  if (!parsed.ok) {
    throw new Error(`AI returned error for chapter ${n}: ${parsed.errorReason ?? "unknown"}; raw[0..200]=${raw.slice(0, 200)}`);
  }
  const f = parsed.fields;

  for (const k of ["CHAPTER_TEXT", "NEXT_OPTIONS_1", "NEXT_OPTIONS_2", "NEXT_OPTIONS_3"]) {
    if (!f[k]) throw new Error(`AI output missing field: ${k}`);
  }

  // Update story state (mutable per-chapter context).
  const newState = {
    ...s,
    global_summary:    f.GLOBAL_SUMMARY    ?? s.global_summary,
    world_state:       f.WORLD_STATE       ?? s.world_state,
    character_state:   f.CHARACTER_STATE   ?? s.character_state,
    relationship_map:  f.RELATIONSHIP_MAP  ?? s.relationship_map,
    timeline_state:    f.TIMELINE_STATE    ?? s.timeline_state,
    open_loops:        f.OPEN_LOOPS        ?? s.open_loops,
  };

  await db.from("stories").update({
    current_chapter_number: n,
    state: newState,
    last_error: null,
  }).eq("id", story.id);

  await db.from("chapters").insert({
    story_id:                  story.id,
    chapter_number:            n,
    text:                      f.CHAPTER_TEXT,
    summary:                   f.CHAPTER_SUMMARY,
    mood:                      f.CHAPTER_MOOD,
    key_event:                 f.CHAPTER_KEY_EVENT,
    closure_hook:              f.CHAPTER_CLOSURE_HOOK,
    next_chapter_goal:         f.NEXT_CHAPTER_GOAL,
    next_chapter_arc_position: f.NEXT_CHAPTER_ARC_POSITION,
    next_chapter_tone_hint:    f.NEXT_CHAPTER_TONE_HINT,
    next_chapter_stakes_level: f.NEXT_CHAPTER_STAKES_LEVEL,
    option_1:                  f.NEXT_OPTIONS_1,
    option_2:                  f.NEXT_OPTIONS_2,
    option_3:                  f.NEXT_OPTIONS_3,
  });

  await sendChapterEmail(db, story.id, n, story.lead_email, story.title ?? "Your story",
    f.CHAPTER_TEXT, [f.NEXT_OPTIONS_1, f.NEXT_OPTIONS_2, f.NEXT_OPTIONS_3]);
}


// ===================================================================
// Email helper
// ===================================================================
async function sendChapterEmail(
  db: ReturnType<typeof adminClient>,
  storyId: string,
  chapterNumber: number,
  to: string,
  storyTitle: string,
  chapterText: string,
  options: [string, string, string],
) {
  // Look up target_chapter_count to know if this is the final chapter.
  const { data: s } = await db
    .from("stories").select("target_chapter_count").eq("id", storyId).maybeSingle();
  const total = s?.target_chapter_count ?? 10;
  const isFinal = chapterNumber >= total;

  const { subject, html, text } = buildChapterEmail({
    storyTitle, chapterNumber, totalChapters: total, chapterText,
    options, storyId, chapterUrlBase: CHAPTER_URL_BASE, isFinalChapter: isFinal,
  });

  await sendEmail({ to, subject, html, text });

  await db.from("chapters")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("story_id", storyId).eq("chapter_number", chapterNumber);
}
