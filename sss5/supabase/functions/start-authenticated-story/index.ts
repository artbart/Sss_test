// POST /functions/v1/start-authenticated-story
//
// Called from the in-app quiz (sss-app/quiz.html) with the user's JWT.
// Starts a NEW story for a logged-in subscriber: validates the 15 answers,
// enforces access + the monthly quota, creates the quiz_session + story rows,
// and triggers chapter-1 generation.
//
// Access rule: paid-through (users.current_period_end >= now) — NOT status —
// so a cancel-at-period-end user keeps access until the period ends. Matches
// submit-choice and the funnel gate.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Anti-abuse cap.
const MONTHLY_STORY_LIMIT = 3;

function startOfCurrentMonthISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0)).toISOString();
}
function startOfNextMonthISO(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 0, 0)).toISOString();
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return jsonResponse({ error: "Authentication required" }, 401);
  const userJwt = authHeader.slice(7);

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return jsonResponse({ error: "Invalid or expired session — sign in again" }, 401);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try {
    body = await req.json();
  } catch (_) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const a = body?.answers ?? {};
  const required = ["character", "feeling", "fantasy", "power", "emotion", "start", "missing", "romance_type", "experience", "reason", "spicy_trigger", "intense", "explicit", "explore", "relationship"];
  for (const k of required) {
    const v = a[k];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === "") {
      return jsonResponse({ error: `Missing required answer: ${k}` }, 400);
    }
  }

  const db = adminClient();
  const { data: profile, error: profErr } = await db
    .from("users")
    .select("id, email, subscription_status, current_period_end")
    .eq("id", user.id)
    .maybeSingle();
  if (profErr || !profile) return jsonResponse({ error: "User profile not found", detail: profErr?.message }, 404);

  // Access gate: paid-through must be in the future.
  const periodEnd = profile.current_period_end ? new Date(profile.current_period_end) : null;
  if (!periodEnd || periodEnd < new Date()) {
    return jsonResponse(
      { error: "Active subscription required to start a new story", subscription_status: profile.subscription_status },
      403,
    );
  }

  const monthStart = startOfCurrentMonthISO();
  const { count: createdThisMonth, error: countErr } = await db
    .from("stories")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .gte("created_at", monthStart);
  if (countErr) return jsonResponse({ error: "Couldn't check monthly quota", detail: countErr.message }, 500);

  const used = createdThisMonth ?? 0;
  if (used >= MONTHLY_STORY_LIMIT) {
    const resetIso = startOfNextMonthISO();
    await db.from("events").insert({
      user_id: profile.id,
      email: profile.email,
      event_type: "story_creation_blocked_monthly_cap",
      metadata: { used, limit: MONTHLY_STORY_LIMIT, resets_at: resetIso },
    });
    return jsonResponse({
      error: `You've used all ${MONTHLY_STORY_LIMIT} of your stories this month`,
      detail: `Your quota resets at the start of next month.`,
      used,
      limit: MONTHLY_STORY_LIMIT,
      resets_at: resetIso,
    }, 429);
  }

  const spicyArr = Array.isArray(a.spicy_trigger) ? a.spicy_trigger : String(a.spicy_trigger).split("||").filter(Boolean);
  const nowIso = new Date().toISOString();

  const { data: session, error: sessionErr } = await db.from("quiz_sessions").insert({
    email: profile.email,
    email_captured_at: nowIso,
    device_type: a.device_type ?? "unknown",
    funnel_version: "app_authenticated_v1",
    landing_page: a.landing_page ?? "https://app.stuffsosweet.com/quiz.html",
    user_agent: a.user_agent ?? null,
    q_character: a.character, q_feeling: a.feeling, q_fantasy: a.fantasy, q_power: a.power, q_emotion: a.emotion,
    q_start: a.start, q_missing: a.missing, q_romance_type: a.romance_type, q_experience: a.experience, q_reason: a.reason,
    q_spicy_trigger: spicyArr, q_intense: a.intense, q_explicit: a.explicit, q_explore: a.explore, q_relationship: a.relationship,
    paid: true, payment_at: nowIso, plan: "subscription", status: "completed",
  }).select("id").single();
  if (sessionErr) return jsonResponse({ error: "Couldn't create quiz session", detail: sessionErr.message, code: sessionErr.code ?? null }, 500);

  const { data: story, error: storyErr } = await db.from("stories")
    .insert({ session_id: session.id, lead_email: profile.email, user_id: profile.id })
    .select("id").single();
  if (storyErr) return jsonResponse({ error: "Couldn't create story", detail: storyErr.message, code: storyErr.code ?? null }, 500);

  await db.from("events").insert({
    user_id: profile.id,
    email: profile.email,
    event_type: "story_started_authenticated",
    story_id: story.id,
    metadata: { source: "app_quiz", used_after: used + 1, monthly_limit: MONTHLY_STORY_LIMIT },
  });

  const generateUrl = `${SUPABASE_URL}/functions/v1/generate-chapter`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const fire = fetch(generateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
    body: JSON.stringify({ story_id: story.id, target_chapter_number: 1 }),
  }).catch((e) => console.error("trigger generate-chapter failed:", e));
  // @ts-ignore EdgeRuntime is a Supabase global
  (globalThis as any).EdgeRuntime?.waitUntil?.(fire);

  return jsonResponse({ ok: true, story_id: story.id, quota: { used: used + 1, limit: MONTHLY_STORY_LIMIT } });
});
