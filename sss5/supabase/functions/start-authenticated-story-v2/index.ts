// POST /functions/v1/start-authenticated-story-v2
//
// Called from the in-app V2 quiz (sss-app/quiz2.html) with the user's JWT.
// Starts a NEW V2 story for a logged-in subscriber: validates the V2 answers,
// enforces the same access + monthly-quota rules as V1, creates a quiz2_sessions
// row + stories row (quiz_version=2), and triggers generate-chapter-v2.
//
// V1 equivalent: start-authenticated-story. Same semantics, different quiz
// schema + different generate-chapter target.
//
// Access rule: lifetime OR paid-through — users.lifetime_at set grants permanent
// access; otherwise users.current_period_end >= now. The single decision lives in
// _shared/access.ts (resolveAccess + hasAccess); this file must never re-derive
// it inline.
// Quota rule: tier-dependent, via storyLimitFor(planTier) — 3 stories per user
// per calendar month on 'standard', 1 on 'lite' (counts BOTH V1 + V2). Lifetime
// does NOT lift the cap.
// v5: setup_depth is optional and defaults to "quick" — the sweet-spice quiz path skips that step.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";
import { resolveAccess, hasAccess, storyLimitFor } from "../_shared/access.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  // Authenticate via user's JWT (not service role).
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
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  // V2 payload matches the marketing-side submit-quiz2 payload shape
  // (payload.in_story, payload.pairing, ...). The in-app quiz collects the same
  // Q1-Q9 answers, so accepting the same shape keeps the two entry points
  // uniform. See _shared/prompts_v2.ts + supabase/functions/submit-quiz2 for
  // the field contract.
  const p = body?.payload ?? {};
  // v5: setup_depth is optional — the sweet-spice quiz path skips that step. Defaults to "quick" below.
  const required = ["in_story", "pairing", "world", "love_interest", "opening", "spicy", "mood"];
  for (const k of required) {
    const v = (p as Record<string, unknown>)[k];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === "") {
      return jsonResponse({ error: `Missing required V2 answer: ${k}` }, 400);
    }
  }
  // No age gate here: the in-app quiz serves users who already confirmed 18+ in the
  // marketing funnel (Sss_test/quiz2/index.html) before paying. sss-app/quiz2.html
  // deliberately does not send age_confirmed for this path.

  const db = adminClient();
  const { data: profile, error: profErr } = await db
    .from("users")
    .select("id, email, display_name, subscription_status, current_period_end, extra_story_credits")
    .eq("id", user.id)
    .maybeSingle();
  if (profErr || !profile) return jsonResponse({ error: "User profile not found", detail: profErr?.message }, 404);

  // Access gate: lifetime holders always pass; otherwise paid-through must be
  // in the future. Shared with submit-choice via _shared/access.ts.
  const access = await resolveAccess(db, profile.id);
  if (access.lookupFailed) {
    return jsonResponse({ error: "Couldn't verify subscription access", detail: "access lookup failed, please retry" }, 500);
  }
  if (!hasAccess(access)) {
    return jsonResponse(
      { error: "Active subscription required to start a new story", subscription_status: access.subStatus },
      403,
    );
  }
  const storyLimit = storyLimitFor(access.planTier);
  // Lifetime credits from $4.99 story packs — added by stripe-webhook on
  // checkout.session.completed with metadata.type=story_pack_3. Extend the
  // monthly quota; consumed one-at-a-time when a user creates a story past
  // the plan's base_limit (see decrement below, after the story insert).
  const extraCredits = Number(profile.extra_story_credits ?? 0) || 0;
  const effectiveLimit = storyLimit + extraCredits;

  // Monthly quota — counts V1 + V2 combined (all stories.user_id rows).
  const monthStart = startOfCurrentMonthISO();
  const { count: createdThisMonth, error: countErr } = await db
    .from("stories")
    .select("id", { count: "exact", head: true })
    .eq("user_id", profile.id)
    .gte("created_at", monthStart);
  if (countErr) return jsonResponse({ error: "Couldn't check monthly quota", detail: countErr.message }, 500);

  const used = createdThisMonth ?? 0;
  if (used >= effectiveLimit) {
    // Blocked. Return `reason: "quota"` so the quiz frontend can offer the
    // top-up modal inline instead of dumping the user out with an error.
    const resetIso = startOfNextMonthISO();
    await db.from("events").insert({
      user_id: profile.id, email: profile.email,
      event_type: "story_creation_blocked_monthly_cap",
      metadata: {
        used, limit: storyLimit, extra_credits: extraCredits, effective_limit: effectiveLimit,
        resets_at: resetIso, quiz_version: 2,
      },
    });
    return jsonResponse({
      error: `You've used all ${effectiveLimit} of your stories this month`,
      detail: `Buy a story pack to keep going, or wait for the monthly reset.`,
      reason: "quota",
      used, limit: storyLimit, extra_credits: extraCredits, effective_limit: effectiveLimit,
      resets_at: resetIso,
    }, 429);
  }
  // If we're only allowed past the base_limit because credits exist, we owe
  // Stripe a decrement AFTER the story insert lands (below). Flag now so the
  // late code path doesn't have to re-derive the math.
  const consumesCredit = used >= storyLimit && extraCredits > 0;

  // v5: sync display_name from q1b_you.name for accounts that don't have one yet.
  // Editing the name on a subsequent quiz2 does NOT overwrite display_name — that's
  // "this-story-only". Only the very first story fills the account name.
  const yourName = (p.you && typeof p.you === "object" && typeof p.you.name === "string")
    ? p.you.name.trim().slice(0, 40)
    : "";
  if (!profile.display_name && yourName) {
    await db.from("users").update({ display_name: yourName }).eq("id", profile.id);
  }

  const nowIso = new Date().toISOString();

  // Insert quiz2_sessions row: paid = true, plan = 'subscription' (marker for
  // authed-source), pre-populated with all V2 quiz fields.
  const { data: session, error: sessionErr } = await db.from("quiz2_sessions").insert({
    email: profile.email,
    email_captured_at: nowIso,
    device_type: p.device_type ?? "unknown",
    funnel_version: "app_authenticated_v2",
    landing_page: p.landing_page ?? "https://app.stuffsosweet.com/quiz2.html",
    user_agent: p.user_agent ?? null,
    q0_age_confirmed: true,   // see the age-gate note above — confirmed in the marketing funnel
    q1_in_story: p.in_story,
    q1b_you: p.you ?? null,
    q2_pairing: p.pairing,
    q3_world: p.world,
    q4_love_interest: p.love_interest,
    q5_opening: p.opening,
    q6_spicy: p.spicy,
    q7_mood: p.mood ?? [],
    q8_specifics: p.specifics ?? [],
    q8b_setup_depth: p.setup_depth || "quick",  // v5: default when the quiz path skipped the step
    q9_skip: p.skip ?? null,
    d_restraint: p.restraint ?? null,
    d_sensory: p.sensory ?? null,
    d_talk: p.talk ?? null,
    d_aftercare: p.aftercare ?? null,
    d_paranormal_kind: p.paranormal_kind ?? null,
    d_monster_flavor: p.monster_flavor ?? null,
    d_omegaverse: p.omegaverse ?? null,
    d_size: p.size ?? null,
    d_partner_dynamic: p.partner_dynamic ?? null,
    d_dark_kind: p.dark_kind ?? null,
    d_dark_consent: p.dark_consent ?? null,
    d_voyeur: p.voyeur ?? null,
    notification_preference_choice: p.notification_preference_choice ?? "email_link_only",
    paid: true, payment_at: nowIso, plan: "subscription", status: "completed",
    subscription_status: "active",
    current_period_start: profile["current_period_end"] ? nowIso : null,
    current_period_end: profile.current_period_end,
  }).select("id").single();
  if (sessionErr) return jsonResponse({ error: "Couldn't create quiz2 session", detail: sessionErr.message, code: sessionErr.code ?? null }, 500);

  // Insert stories row with quiz_version=2 + quiz2_session_id.
  const { data: story, error: storyErr } = await db.from("stories")
    .insert({
      quiz_version: 2,
      quiz2_session_id: session.id,
      lead_email: profile.email,
      user_id: profile.id,
      status: "pending",
    })
    .select("id").single();
  if (storyErr) return jsonResponse({ error: "Couldn't create V2 story", detail: storyErr.message, code: storyErr.code ?? null }, 500);

  // Consume one credit if this story is past the base monthly limit. The
  // .gt("extra_story_credits", 0) guard makes it a no-op if a concurrent
  // request already zeroed the pool — better a phantom-free story than a
  // negative credit balance. The CHECK constraint on the column also blocks
  // negatives at the DB layer as belt-and-braces.
  let creditsAfter: number | null = null;
  if (consumesCredit) {
    // Read-then-write so we can return the post-decrement value to the
    // client (for the "N credits left" hint). Same row, same request —
    // race window is negligible in practice.
    const { data: fresh } = await db.from("users")
      .select("extra_story_credits").eq("id", profile.id).maybeSingle();
    const current = Number(fresh?.extra_story_credits ?? 0) || 0;
    if (current > 0) {
      const next = current - 1;
      const { data: dec, error: decErr } = await db.from("users")
        .update({ extra_story_credits: next })
        .eq("id", profile.id)
        .gt("extra_story_credits", 0)
        .select("extra_story_credits");
      if (decErr) {
        console.error(`credit decrement failed for user ${profile.id} story ${story.id}:`, decErr);
      } else if (dec && dec.length) {
        creditsAfter = Number(dec[0].extra_story_credits ?? 0);
      }
    }
  }

  await db.from("events").insert({
    user_id: profile.id, email: profile.email,
    event_type: "story_started_authenticated", story_id: story.id,
    metadata: {
      source: "app_quiz2", quiz_version: 2,
      used_after: used + 1, monthly_limit: storyLimit,
      credit_consumed: consumesCredit, extra_credits_after: creditsAfter,
    },
  });

  // Trigger generate-chapter-v2 in the background (edge function has ~6-min
  // budget with retries + emergency fallback; we don't wait for it).
  const generateUrl = `${SUPABASE_URL}/functions/v1/generate-chapter-v2`;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const fire = fetch(generateUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
    },
    body: JSON.stringify({ story_id: story.id, target_chapter_number: 1 }),
  }).catch((e) => console.error("trigger generate-chapter-v2 failed:", e));
  // @ts-ignore EdgeRuntime is a Supabase global
  (globalThis as any).EdgeRuntime?.waitUntil?.(fire);

  return jsonResponse({
    ok: true,
    story_id: story.id,
    quiz2_session_id: session.id,
    quota: {
      used: used + 1,
      limit: storyLimit,
      extra_credits: creditsAfter ?? extraCredits,
      credit_consumed: consumesCredit,
    },
  });
});
