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

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return jsonResponse({ status: "error", message: "Method not allowed" }, 405);
  }

  let body: { story_id?: string; chapter_number?: number | string; option?: number | string };
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

  const db = adminClient();

  // Load the chapter to check duplicate state and confirm the row exists.
  const { data: chapter, error: chErr } = await db
    .from("chapters")
    .select("id, chosen_option")
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

  // Record the choice.
  const { error: upErr } = await db
    .from("chapters")
    .update({
      chosen_option: option,
      chosen_at: new Date().toISOString(),
    })
    .eq("id", chapter.id);

  if (upErr) {
    console.error("chapter update failed:", upErr);
    return jsonResponse({ status: "error", message: "DB update failed" }, 500);
  }

  // Check whether we've reached the target chapter count.
  const { data: story } = await db
    .from("stories")
    .select("target_chapter_count")
    .eq("id", storyId)
    .maybeSingle();
  const target = story?.target_chapter_count ?? 10;

  if (chapterNumber >= target) {
    // Story complete — no more chapters to generate.
    await db.from("stories").update({ status: "completed" }).eq("id", storyId);
    return jsonResponse({ status: "ok", final: true });
  }

  // Trigger next-chapter generation in the background.
  const generateUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-chapter`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const trigger = fetch(generateUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      story_id: storyId,
      target_chapter_number: chapterNumber + 1,
    }),
  }).catch((e) => console.error("background generate-chapter failed:", e));

  // @ts-ignore - EdgeRuntime is a Supabase global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(trigger);
  }

  return jsonResponse({ status: "ok" });
});
