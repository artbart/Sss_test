// POST /functions/v1/generate-chapter-v2   (verify_jwt = true; service-role only)
//
// V2 equivalent of generate-chapter. Internal endpoint, called by:
//   - stripe-webhook (target=1) when a V2 quiz payment fires invoice.paid
//   - submit-choice  (target=N+1) when a V2 story reader picks an option
//
// Both call sites route based on stories.quiz_version — V1 goes to generate-chapter,
// V2 goes here. See _shared/version_router.ts for the convention-based helper.
//
// Body:
//   { story_id: uuid, target_chapter_number: number }
//
// Behavior:
//   - For chapter 1: load quiz2_session by stories.quiz2_session_id, build V2
//     prompt via prompts_v2, run through generate_with_retry, parse, save story
//     metadata + chapters row 1, send email.
//   - For chapter N+1: same as V1 — load story state + previous chapter's choice,
//     build V2 continuation prompt, retry-wrapped Claude call, parse, save, email.
//
// Uses shared retry infrastructure (_shared/generate_with_retry.ts) so a single
// Claude refusal or format error never breaks the arc.

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/resend.ts";
import { parseLabeled } from "../_shared/parse.ts";
import { buildChapterEmail, buildShortNotificationEmail } from "../_shared/email_html.ts";
import {
  chapter1PromptV2, chapterNPromptV2,
  type Quiz2Context, type ChapterNContextV2,
} from "../_shared/prompts_v2.ts";
import {
  pickRandomBucket, pickRandomSeed,
  type VarietyContext, type PriorStorySnapshot,
} from "../_shared/variety.ts";
import { generateChapterWithRetry } from "../_shared/generate_with_retry.ts";

const CHAPTER_URL_BASE =
  Deno.env.get("CHAPTER_URL_BASE") ?? "https://stuffsosweet.com/chapter_update.html";

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

  // Idempotency: if the chapter already exists, no-op.
  const { data: existing } = await db
    .from("chapters")
    .select("id")
    .eq("story_id", storyId)
    .eq("chapter_number", target)
    .maybeSingle();
  if (existing) {
    return jsonResponse({ ok: true, skipped: "chapter already exists" });
  }

  // Load story.
  const { data: story, error: storyErr } = await db
    .from("stories")
    .select("*")
    .eq("id", storyId)
    .maybeSingle();
  if (storyErr || !story) {
    return jsonResponse({ error: "story not found" }, 404);
  }

  // Defensive: this function only handles V2 stories. If a V1 story reaches here
  // by mistake (routing bug), fail loudly rather than write garbage.
  if (story.quiz_version !== 2) {
    return jsonResponse({
      error: `wrong engine: story ${storyId} is quiz_version=${story.quiz_version}, expected 2`,
    }, 400);
  }

  try {
    if (target === 1) {
      await generateChapterOneV2(db, story);
    } else {
      await generateChapterNV2(db, story, target);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.error("generate-chapter-v2 failed:", msg);
    await db
      .from("stories")
      .update({ status: "error", last_error: msg.slice(0, 4000) })
      .eq("id", storyId);
    return jsonResponse({ error: msg }, 500);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// Chapter 1 — V2
// ═══════════════════════════════════════════════════════════════════════════════
async function generateChapterOneV2(db: ReturnType<typeof adminClient>, story: any) {
  // Load V2 quiz session for the prompt context.
  if (!story.quiz2_session_id) {
    throw new Error(`story ${story.id} has quiz_version=2 but no quiz2_session_id`);
  }

  const { data: session, error: sErr } = await db
    .from("quiz2_sessions")
    .select("*")
    .eq("id", story.quiz2_session_id)
    .single();
  if (sErr || !session) {
    throw new Error(`quiz2_session not found for story ${story.id}: ${sErr?.message ?? "no data"}`);
  }

  // Map DB row → Quiz2Context (structural, no transformation needed since column
  // names match field names).
  const quiz: Quiz2Context = {
    q0_age_confirmed:  session.q0_age_confirmed,
    q1_in_story:       session.q1_in_story,
    q1b_you:           session.q1b_you,
    q2_pairing:        session.q2_pairing,
    q3_world:          session.q3_world,
    q4_love_interest:  session.q4_love_interest,
    q5_opening:        session.q5_opening,
    q6_spicy:          session.q6_spicy,
    q7_mood:           session.q7_mood ?? [],
    q8_specifics:      session.q8_specifics ?? [],
    q8b_setup_depth:   session.q8b_setup_depth,
    q9_skip:           session.q9_skip,
    d_restraint:       session.d_restraint,
    d_sensory:         session.d_sensory ?? [],
    d_talk:            session.d_talk ?? [],
    d_aftercare:       session.d_aftercare,
    d_paranormal_kind: session.d_paranormal_kind ?? [],
    d_monster_flavor:  session.d_monster_flavor ?? [],
    d_omegaverse:      session.d_omegaverse ?? [],
    d_size:            session.d_size,
    d_partner_dynamic: session.d_partner_dynamic,
    d_dark_kind:       session.d_dark_kind,
    d_dark_consent:    session.d_dark_consent,
    d_voyeur:          session.d_voyeur,
  };

  // Variety context (prior stories + random seed + title bucket).
  const variety = await buildVarietyContext(db, story);

  const prompt = chapter1PromptV2(quiz, story.target_chapter_count ?? 10, variety);

  // Run through the fail-safe retry wrapper.
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const result = await generateChapterWithRetry({
    storyId: story.id,
    chapterNumber: 1,
    quizVersion: 2,
    originalPrompt: prompt,
    anthropicApiKey,
    maxTokens: 8000,
  });

  if (!result.success || !result.chapter_text) {
    const kind = result.final_error_kind ?? "unknown";
    throw new Error(
      `generate-chapter-v2 chapter 1 failed after ${result.attempts.length} attempts (final: ${kind})`,
    );
  }

  // Parse the labeled output.
  const parsed = parseLabeled(result.chapter_text);
  if (!parsed.ok) {
    throw new Error(
      `parse failed on chapter 1 (V2): ${parsed.errorReason ?? "unknown"}; raw[0..200]=${result.chapter_text.slice(0, 200)}`,
    );
  }
  const f = parsed.fields;

  // In emergency-fallback mode, Claude sometimes drops scaffolding fields
  // (STORY_TITLE, NEXT_OPTIONS_*) even when it delivers a full chapter body.
  // Rather than fail the story after all retries burned, synthesize sensible
  // defaults so the "always deliver a chapter" contract holds. The user gets
  // a competent chapter; ops sees was_emergency_fallback=true in events and
  // can revisit the prompt if it becomes a pattern.
  if (result.was_emergency_fallback) {
    if (!f.STORY_TITLE || f.STORY_TITLE.trim().length < 2) {
      f.STORY_TITLE = "An Unwritten Story";
    }
    // Emergency prompt asks for options as a single NEXT_OPTIONS_1 block with
    // three numbered lines. If the parser split them into 1/2/3 already, keep
    // those. Otherwise try to split NEXT_OPTIONS_1 into three lines.
    if (!f.NEXT_OPTIONS_2 && !f.NEXT_OPTIONS_3 && f.NEXT_OPTIONS_1) {
      const lines = f.NEXT_OPTIONS_1.split(/\n+/).map((l) => l.replace(/^\s*\d+[\.\):-]?\s*/, "").trim()).filter(Boolean);
      if (lines.length >= 3) {
        f.NEXT_OPTIONS_1 = lines[0];
        f.NEXT_OPTIONS_2 = lines[1];
        f.NEXT_OPTIONS_3 = lines[2];
      }
    }
    if (!f.NEXT_OPTIONS_1) f.NEXT_OPTIONS_1 = "Continue exactly where things left off.";
    if (!f.NEXT_OPTIONS_2) f.NEXT_OPTIONS_2 = "Push the intensity higher — take a bolder step.";
    if (!f.NEXT_OPTIONS_3) f.NEXT_OPTIONS_3 = "Slow the pace and let the emotional weight settle.";
    if (!f.STORY_GENRE) f.STORY_GENRE = "Contemporary Romance / Erotic Fiction";
    if (!f.TONE_LABEL) f.TONE_LABEL = "Emotionally grounded";
    if (!f.HEAT_LEVEL) f.HEAT_LEVEL = "Spicy";
    if (!f.SETTING_TYPE) f.SETTING_TYPE = "Contemporary";
    if (!f.CHAPTER_1_SUMMARY) f.CHAPTER_1_SUMMARY = f.CHAPTER_1_TEXT.slice(0, 200).replace(/\s+\S*$/, "…");
    console.log(`[V2 emergency-fallback] synthesized missing scaffolding for story ${story.id}`);
  }

  // Validate must-have fields (after emergency synthesis, so genuine failures still throw).
  for (const k of ["CHAPTER_1_TEXT", "STORY_TITLE", "NEXT_OPTIONS_1", "NEXT_OPTIONS_2", "NEXT_OPTIONS_3"]) {
    if (!f[k]) throw new Error(`V2 AI output missing field: ${k}`);
  }

  // Persist story metadata + state.
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

  // Send chapter email (reuses V1 email logic — quiz-version-agnostic).
  await sendChapterEmail(db, story.id, 1, story.lead_email, f.STORY_TITLE,
    f.CHAPTER_1_TEXT, [f.NEXT_OPTIONS_1, f.NEXT_OPTIONS_2, f.NEXT_OPTIONS_3]);
}


// ═══════════════════════════════════════════════════════════════════════════════
// Chapter N (>= 2) — V2
// ═══════════════════════════════════════════════════════════════════════════════
async function generateChapterNV2(db: ReturnType<typeof adminClient>, story: any, n: number) {
  // Load quiz2_session so we can carry the reader's hard limits into every chapter.
  if (!story.quiz2_session_id) {
    throw new Error(`story ${story.id} has quiz_version=2 but no quiz2_session_id`);
  }
  const { data: session, error: sErr } = await db
    .from("quiz2_sessions")
    .select("*")
    .eq("id", story.quiz2_session_id)
    .single();
  if (sErr || !session) {
    throw new Error(`quiz2_session not found for story ${story.id}`);
  }

  // Load previous chapter (n-1).
  const { data: prev, error: prevErr } = await db
    .from("chapters")
    .select("*")
    .eq("story_id", story.id)
    .eq("chapter_number", n - 1)
    .single();
  if (prevErr || !prev) throw new Error(`prev chapter ${n - 1} not found for V2 story ${story.id}`);
  if (!prev.chosen_option) throw new Error(`prev chapter ${n - 1} has no chosen_option`);

  const chosenText =
    prev.chosen_option === 1 ? prev.option_1 :
    prev.chosen_option === 2 ? prev.option_2 :
                               prev.option_3;
  if (!chosenText) throw new Error(`prev chapter option_${prev.chosen_option} text is empty`);

  const s = (story.state ?? {}) as Record<string, string | null>;

  // Reconstruct Quiz2Context so chapterNPromptV2 can enforce hard limits.
  const quiz: Quiz2Context = {
    q1_in_story:       session.q1_in_story,
    q1b_you:           session.q1b_you,
    q6_spicy:          session.q6_spicy,
    q9_skip:           session.q9_skip,
    q8b_setup_depth:   session.q8b_setup_depth,
    d_dark_consent:    session.d_dark_consent,
    // (Only fields the chapterNPromptV2 actually uses — POV branching + hard limits)
  };

  const ctx: ChapterNContextV2 = {
    chapterNumber: n,
    quiz,
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

  const prompt = chapterNPromptV2(ctx);

  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicApiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const result = await generateChapterWithRetry({
    storyId: story.id,
    chapterNumber: n,
    quizVersion: 2,
    originalPrompt: prompt,
    anthropicApiKey,
    // 8000 tokens matches chapter 1 and leaves headroom for the 10+ scaffolding
    // fields chapter N needs (world/character/relationship state carry-over) plus
    // a ~2000-word body. Chapter 4 hit the 6000 ceiling and got truncated
    // mid-response, chopping off NEXT_OPTIONS_* and forcing a format_error retry.
    maxTokens: 8000,
  });

  if (!result.success || !result.chapter_text) {
    const kind = result.final_error_kind ?? "unknown";
    throw new Error(
      `generate-chapter-v2 chapter ${n} failed after ${result.attempts.length} attempts (final: ${kind})`,
    );
  }

  const parsed = parseLabeled(result.chapter_text);
  if (!parsed.ok) {
    throw new Error(`parse failed on V2 chapter ${n}: ${parsed.errorReason ?? "unknown"}`);
  }
  const f = parsed.fields;

  for (const k of ["CHAPTER_TEXT", "NEXT_OPTIONS_1", "NEXT_OPTIONS_2", "NEXT_OPTIONS_3"]) {
    if (!f[k]) throw new Error(`V2 chapter ${n} AI output missing field: ${k}`);
  }

  // Update story state.
  const newState = {
    ...s,
    global_summary:    f.GLOBAL_SUMMARY ?? s.global_summary,
    world_state:       f.WORLD_STATE ?? s.world_state,
    character_state:   f.CHARACTER_STATE ?? s.character_state,
    relationship_map:  f.RELATIONSHIP_MAP ?? s.relationship_map,
    timeline_state:    f.TIMELINE_STATE ?? s.timeline_state,
    open_loops:        f.OPEN_LOOPS ?? s.open_loops,
  };

  await db.from("stories").update({
    current_chapter_number: n,
    state:                  newState,
    last_error:             null,
  }).eq("id", story.id);

  // Insert chapter N row.
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

  // Chapter email.
  await sendChapterEmail(db, story.id, n, story.lead_email, story.title,
    f.CHAPTER_TEXT, [f.NEXT_OPTIONS_1, f.NEXT_OPTIONS_2, f.NEXT_OPTIONS_3]);
}


// ═══════════════════════════════════════════════════════════════════════════════
// Variety context helper — same shape as V1, quiz-version-agnostic
// ═══════════════════════════════════════════════════════════════════════════════
async function buildVarietyContext(
  db: ReturnType<typeof adminClient>,
  story: any,
): Promise<VarietyContext | undefined> {
  if (!story.user_id) {
    // Guest / not-yet-signed-up story — use random seed only, no prior context.
    return { bucket: pickRandomBucket(), seed: pickRandomSeed(), priorStories: [] };
  }

  const { data: rows } = await db
    .from("stories")
    .select("id, title, character_archetype, setting_type")
    .eq("user_id", story.user_id)
    .neq("id", story.id)
    .order("created_at", { ascending: false })
    .limit(5);

  const priorStories: PriorStorySnapshot[] = await Promise.all((rows ?? []).map(async (r) => {
    const { data: ch1 } = await db
      .from("chapters")
      .select("text")
      .eq("story_id", r.id)
      .eq("chapter_number", 1)
      .maybeSingle();
    return {
      title: r.title,
      character_archetype: r.character_archetype,
      setting_type: r.setting_type,
      opening_excerpt: ch1?.text ? String(ch1.text).slice(0, 120) : null,
    };
  }));

  return {
    bucket: pickRandomBucket(),
    seed: pickRandomSeed(),
    priorStories,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// Email helper — identical to V1 (quiz-version-agnostic)
// ═══════════════════════════════════════════════════════════════════════════════
async function sendChapterEmail(
  db: ReturnType<typeof adminClient>,
  storyId: string,
  chapterNumber: number,
  to: string,
  storyTitle: string,
  chapterText: string,
  options: [string, string, string],
) {
  const { data: s } = await db
    .from("stories")
    .select("target_chapter_count, user_id")
    .eq("id", storyId)
    .maybeSingle();
  const total = s?.target_chapter_count ?? 10;
  const isFinal = chapterNumber >= total;

  let pref = "email_full_story";
  if (s?.user_id) {
    const { data: u } = await db
      .from("users")
      .select("notification_preference")
      .eq("id", s.user_id)
      .maybeSingle();
    if (u?.notification_preference) pref = u.notification_preference;
  }

  if (pref === "in_app_only") {
    await db.from("chapters")
      .update({ email_sent_at: new Date().toISOString() })
      .eq("story_id", storyId).eq("chapter_number", chapterNumber);
    return;
  }

  let subject: string, html: string, text: string;
  if (pref === "email_link_only") {
    // Same magic-link-in-email pattern as V1 sendChapterEmail.
    let ctaUrl: string | undefined;
    try {
      const next = `/chapter.html?story=${encodeURIComponent(storyId)}&n=${chapterNumber}`;
      const redirectTo = `https://app.stuffsosweet.com/auth/callback?next=${encodeURIComponent(next)}`;
      const { data, error } = await db.auth.admin.generateLink({
        type: "magiclink",
        email: to,
        options: { redirectTo },
      });
      if (error) {
        console.error(`[v2 chapter-email] generateLink failed for ${to}:`, error);
      } else if (data?.properties?.action_link) {
        ctaUrl = data.properties.action_link;
      }
    } catch (e) {
      console.error(`[v2 chapter-email] generateLink threw for ${to}:`, e);
    }

    ({ subject, html, text } = buildShortNotificationEmail({
      storyTitle, chapterNumber, totalChapters: total,
      storyId, isFinalChapter: isFinal, ctaUrl,
    }));
  } else {
    ({ subject, html, text } = buildChapterEmail({
      storyTitle, chapterNumber, totalChapters: total, chapterText,
      options, storyId, chapterUrlBase: CHAPTER_URL_BASE, isFinalChapter: isFinal,
    }));
  }

  await sendEmail({ to, subject, html, text });

  await db.from("chapters")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("story_id", storyId).eq("chapter_number", chapterNumber);
}
