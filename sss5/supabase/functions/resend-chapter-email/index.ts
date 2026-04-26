// POST /functions/v1/resend-chapter-email   (verify_jwt = true; admin / service-role only)
//
// Recovery function — re-sends the chapter email for an existing chapter row.
// No regeneration, no AI call, no DB writes other than email_sent_at.
//
// Use case: a story got stuck at status=error because the email send failed
// (Resend domain wasn't verified, wrong sender, etc.) but the chapter content
// is sitting in the DB. After fixing the underlying issue (domain verified,
// MAIL_FROM updated, etc.) you can replay the email by calling this.
//
// Body:
//   { story_id: uuid, chapter_number?: number }
// If chapter_number is omitted, defaults to stories.current_chapter_number.
//
// Behavior:
//   1. Load story (need lead_email, title, target_chapter_count).
//   2. Load chapter (need text, options 1/2/3).
//   3. Send email via Resend.
//   4. Update chapters.email_sent_at = now().
//   5. If the story was in status='error', flip it back to 'active'.
//
// Returns: { ok: true, story_id, chapter_number, sent_to } on success.

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { sendEmail } from "../_shared/resend.ts";
import { buildChapterEmail } from "../_shared/email_html.ts";

const CHAPTER_URL_BASE =
  Deno.env.get("CHAPTER_URL_BASE") ?? "https://myhiddenstory.com/chapter_update.html";

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { story_id?: string; chapter_number?: number };
  try { body = await req.json(); }
  catch (_) { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const storyId = (body.story_id ?? "").trim();
  if (!storyId) return jsonResponse({ error: "Missing story_id" }, 400);

  const db = adminClient();

  // Load story
  const { data: story, error: sErr } = await db
    .from("stories")
    .select("id, lead_email, title, target_chapter_count, current_chapter_number, status")
    .eq("id", storyId)
    .maybeSingle();
  if (sErr || !story) {
    return jsonResponse({ error: "story not found", detail: sErr?.message }, 404);
  }

  const chapterNumber = body.chapter_number ?? story.current_chapter_number;
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) {
    return jsonResponse({ error: "Invalid chapter_number (and stories.current_chapter_number was not set)" }, 400);
  }

  // Load chapter
  const { data: chapter, error: cErr } = await db
    .from("chapters")
    .select("id, text, option_1, option_2, option_3")
    .eq("story_id", storyId)
    .eq("chapter_number", chapterNumber)
    .maybeSingle();
  if (cErr || !chapter) {
    return jsonResponse({ error: `chapter ${chapterNumber} not found for story`, detail: cErr?.message }, 404);
  }
  if (!chapter.text) {
    return jsonResponse({ error: "chapter row exists but text is empty" }, 400);
  }

  const total = story.target_chapter_count ?? 10;
  const isFinal = chapterNumber >= total;
  const titleForEmail = story.title || "Your story";
  const options: [string, string, string] = [
    chapter.option_1 ?? "", chapter.option_2 ?? "", chapter.option_3 ?? "",
  ];

  // Build + send the email
  const { subject, html, text } = buildChapterEmail({
    storyTitle: titleForEmail,
    chapterNumber,
    totalChapters: total,
    chapterText: chapter.text,
    options,
    storyId: story.id,
    chapterUrlBase: CHAPTER_URL_BASE,
    isFinalChapter: isFinal,
  });

  try {
    await sendEmail({ to: story.lead_email, subject, html, text });
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    return jsonResponse({ error: "Resend send failed", detail: msg }, 500);
  }

  // Mark email sent + clear error state if applicable
  await db
    .from("chapters")
    .update({ email_sent_at: new Date().toISOString() })
    .eq("id", chapter.id);

  if (story.status === "error") {
    await db
      .from("stories")
      .update({ status: "active", last_error: null })
      .eq("id", storyId);
  }

  return jsonResponse({
    ok: true,
    story_id: storyId,
    chapter_number: chapterNumber,
    sent_to: story.lead_email,
  });
});
