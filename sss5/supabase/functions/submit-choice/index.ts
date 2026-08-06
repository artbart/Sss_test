// POST /functions/v1/submit-choice
//
// Called from chapter.html when a user clicks an option link in their email.
//
// Body shape:
//   { story_id: uuid, chapter_number: number, option: 1 | 2 | 3 }
//
// Returns:
//   { status: "ok" | "duplicate" | "error", message?: string }
//
// Behavior:
//   1. Look up the (story_id, chapter_number) chapter row.
//   2. If chosen_option already set -> "duplicate" (UI shows "already chosen").
//   3. Otherwise update the row with chosen_option + chosen_at.
//   4. Fire generate-chapter for chapter_number + 1 in the background.

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { resolveAccess, hasAccess } from "../_shared/access.ts";
import { getGenerateFunctionUrl, type QuizVersion } from "../_shared/version_router.ts";

// Sanitize a single modifier string. Same principle as sanitizeFeedbackText
// on chapter_ratings: strip HTML/XML tags, drop control chars (keep tab/LF),
// cap length. Belt-and-braces defense — the model-generated modifiers
// shouldn't contain anything nasty, but never trust client input.
function sanitizeModifier(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw;
  s = s.replace(/<[^>]*>/g, "");
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  s = s.trim();
  if (s.length < 3) return null;
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return jsonResponse({ status: "error", message: "Method not allowed" }, 405);
  }

  let body: {
    story_id?: string;
    chapter_number?: number | string;
    option?: number | string;
    modifiers?: unknown;   // IDEA #3 — reader-checked modifier chips (optional)
  };
  try {
    body = await req.json();
  } catch (_) {
    return jsonResponse({ status: "error", message: "Invalid JSON" }, 400);
  }

  const storyId = (body.story_id ?? "").toString().trim();
  const chapterNumber = Number(body.chapter_number);
  const option = Number(body.option);

  if (!storyId || !Number.isInteger(chapterNumber) || ![1, 2, 3].includes(option)) {
    return jsonResponse(
      { status: "error", message: "Missing or invalid story_id / chapter_number / option" },
      400,
    );
  }

  // Validate + sanitize modifiers (optional).
  let cleanModifiers: string[] | null = null;
  if (Array.isArray(body.modifiers)) {
    const cleaned = body.modifiers
      .map(sanitizeModifier)
      .filter((s): s is string => s !== null)
      .slice(0, 10);   // safety cap on count
    if (cleaned.length > 0) cleanModifiers = cleaned;
  }

  const db = adminClient();

  // Load the chapter to check duplicate state and confirm the row exists.
  // Also read next_options_modifiers so we can suppress writes on V1/legacy
  // chapters (no modifiers were rendered → shouldn't be recording any).
  const { data: chapter, error: chErr } = await db
    .from("chapters")
    .select("id, chosen_option, next_options_modifiers")
    .eq("story_id", storyId)
    .eq("chapter_number", chapterNumber)
    .maybeSingle();

  if (chErr) {
    console.error("chapter lookup failed:", chErr);
    return jsonResponse({ status: "error", message: "DB lookup failed" }, 500);
  }
  if (!chapter) {
    return jsonResponse({ status: "error", message: "Chapter not found" }, 404);
  }
  if (chapter.chosen_option) {
    return jsonResponse({ status: "duplicate" });
  }

  // Load the story once: needed for entitlement gate + target + version routing.
  const { data: story } = await db
    .from("stories")
    .select("target_chapter_count, user_id, lead_email, quiz_version")
    .eq("id", storyId)
    .maybeSingle();

  // --- Entitlement gate: generating new content requires paid-through access
  // (or lifetime). Reading existing chapters is unaffected (client reads via
  // RLS). We check BEFORE recording the choice so a lapsed user can retry
  // after reactivating.
  const access = await resolveAccess(db, story?.user_id, story?.lead_email);
  if (access.lookupFailed) {
    console.error("submit-choice: access lookup failed for story", storyId);
    return jsonResponse({ status: "error", message: "Couldn't verify subscription access" }, 500);
  }
  if (!hasAccess(access)) {
    return jsonResponse(
      { status: "error", message: "Subscription required to continue", subscription_status: access.subStatus ?? "none" },
      402,
    );
  }

  // Record the choice. Only persist modifiers if this chapter actually had
  // modifier options rendered (guards V1 stories + edge cases where the
  // client sends a modifiers array on a legacy chapter — DB shouldn't fill
  // up with orphan writes).
  const hadModifiers = chapter.next_options_modifiers != null
    && typeof chapter.next_options_modifiers === "object"
    && Object.keys(chapter.next_options_modifiers).length > 0;

  const updatePayload: Record<string, unknown> = {
    chosen_option: option,
    chosen_at: new Date().toISOString(),
  };
  if (hadModifiers && cleanModifiers && cleanModifiers.length > 0) {
    updatePayload.chosen_modifiers = cleanModifiers;
  }

  const { error: upErr } = await db
    .from("chapters")
    .update(updatePayload)
    .eq("id", chapter.id);

  if (upErr) {
    console.error("chapter update failed:", upErr);
    return jsonResponse({ status: "error", message: "DB update failed" }, 500);
  }

  const target = story?.target_chapter_count ?? 10;

  if (chapterNumber >= target) {
    // Story complete — no more chapters to generate.
    await db.from("stories").update({ status: "completed" }).eq("id", storyId);
    return jsonResponse({ status: "ok", final: true });
  }

  // Trigger next-chapter generation in the background — version-aware routing.
  // V1 stories go to generate-chapter, V2 stories go to generate-chapter-v2, etc.
  const quizVersion = ((story?.quiz_version ?? 1) as QuizVersion);
  const generateUrl = getGenerateFunctionUrl(quizVersion);
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const trigger = fetch(generateUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      story_id: storyId,
      target_chapter_number: chapterNumber + 1,
    }),
  }).catch((e) => console.error(`background generate-chapter (v${quizVersion}) failed:`, e));

  // @ts-ignore - EdgeRuntime is a Supabase global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(trigger);
  }

  return jsonResponse({ status: "ok" });
});
