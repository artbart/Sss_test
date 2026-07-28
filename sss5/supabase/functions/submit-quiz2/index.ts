// POST /functions/v1/submit-quiz2
//
// Called from the public V2 quiz page (anon key, no JWT verification).
// V2 equivalent of submit-quiz. Writes to quiz2_sessions instead of quiz_sessions.
//
// Handles the same three event types the funnel emits:
//   - "email_capture"      : user submits the email step
//   - "plan_selected"      : user picked a checkout plan
//   - "payment_successful" : analytics breadcrumb only (real payment state is set
//                            by stripe-webhook on invoice.paid)
//
// Body shape (same top-level as V1, different payload fields):
//   {
//     session_id: string,   // client-side UUID, used as quiz2_sessions.id
//     event: "email_capture" | "plan_selected" | "payment_successful",
//     payload: { ...V2 quiz answer fields, see Quiz2Payload below }
//   }
//
// Note on payload types:
//   - Multi-selects (q7_mood, q8_specifics, d_*) travel as arrays on the wire
//     (JSON native, not the "||"-joined string V1 uses).
//   - Compound objects (q1b_you, q9_skip) travel as JSON objects.
//   - The client can call this multiple times as the user progresses through the
//     quiz; each call upserts and only includes fields present in the payload.

import { adminClient } from "../_shared/db.ts";
import { handlePreflight, jsonResponse } from "../_shared/cors.ts";

interface Quiz2Payload {
  // identity + contact
  email?: string;
  plan?: string;

  // 18+ gate
  age_confirmed?: boolean;

  // V2 quiz answers (see quiz_draft_v6.html for options)
  in_story?: "no" | "yes";
  you?: { name?: string; gender?: "woman" | "man" | "nb" };
  pairing?: "wm" | "ww" | "mm" | "queer" | "surprise";
  world?: "contemporary" | "historical" | "fantasy_paranormal" | "monster" | "omegaverse" | "surprise";
  love_interest?: "brooding" | "protective" | "playful" | "ruthless" | "wounded" | "cinnamon" | "wildcard" | "surprise";
  opening?: "slow_build" | "meet_cute" | "already_ten" | "one_night" | "forced" | "fresh_start" | "surprise";
  spicy?: "sweet" | "spicy" | "very_spicy";
  mood?: string[];
  specifics?: string[];
  setup_depth?: "quick" | "full";
  skip?: { open_any?: boolean; specifics?: string[]; free_text?: string };

  // drill answers (all optional; only populated if q8b_setup_depth = 'full')
  restraint?: "held" | "light" | "real" | "full";
  sensory?: string[];
  talk?: string[];
  aftercare?: "warm" | "fed" | "quiet" | "playful" | "fade";
  paranormal_kind?: string[];
  monster_flavor?: string[];
  omegaverse?: string[];
  size?: "massive" | "significant" | "present" | "skip";
  partner_dynamic?: "mutual" | "centered" | "two_plus_one" | "hierarchical" | "decide";
  dark_kind?: "mafia" | "villain" | "stalker" | "captor" | "gray" | "full_villain";
  dark_consent?: "fully" | "dubcon" | "cnc" | "skip";
  voyeur?: "watched" | "watching" | "mutual" | "someone_else" | "risk_only";

  // notification preference (same as V1)
  notification_preference_choice?: "email_full_story" | "email_link_only" | "in_app_only";

  // attribution / device (same as V1)
  fbclid?: string;
  fbc?: string;
  funnel_version?: string;
  landing_page?: string;
  user_agent?: string;
  device_type?: string;
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: { session_id?: string; event?: string; payload?: Quiz2Payload };
  try {
    body = await req.json();
  } catch (_) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const sessionId = (body.session_id ?? "").trim();
  const event = (body.event ?? "").trim();
  const p = body.payload ?? {};

  if (!sessionId || !event) {
    return jsonResponse({ error: "Missing session_id or event" }, 400);
  }

  const db = adminClient();

  // --- Build the row to upsert. Only include fields that came through. ---
  const row: Record<string, unknown> = { id: sessionId };

  // identity / contact
  if (p.email) row.email = p.email;
  if (p.plan) row.plan = p.plan;

  // 18+ gate
  if (p.age_confirmed !== undefined) row.q0_age_confirmed = p.age_confirmed;

  // V2 quiz answers — map payload names to column names
  if (p.in_story) row.q1_in_story = p.in_story;
  if (p.you !== undefined) row.q1b_you = p.you;
  if (p.pairing) row.q2_pairing = p.pairing;
  if (p.world) row.q3_world = p.world;
  if (p.love_interest) row.q4_love_interest = p.love_interest;
  if (p.opening) row.q5_opening = p.opening;
  if (p.spicy) row.q6_spicy = p.spicy;
  if (p.mood !== undefined) row.q7_mood = p.mood;
  if (p.specifics !== undefined) row.q8_specifics = p.specifics;
  if (p.setup_depth) row.q8b_setup_depth = p.setup_depth;
  if (p.skip !== undefined) row.q9_skip = p.skip;

  // drill answers
  if (p.restraint) row.d_restraint = p.restraint;
  if (p.sensory !== undefined) row.d_sensory = p.sensory;
  if (p.talk !== undefined) row.d_talk = p.talk;
  if (p.aftercare) row.d_aftercare = p.aftercare;
  if (p.paranormal_kind !== undefined) row.d_paranormal_kind = p.paranormal_kind;
  if (p.monster_flavor !== undefined) row.d_monster_flavor = p.monster_flavor;
  if (p.omegaverse !== undefined) row.d_omegaverse = p.omegaverse;
  if (p.size) row.d_size = p.size;
  if (p.partner_dynamic) row.d_partner_dynamic = p.partner_dynamic;
  if (p.dark_kind) row.d_dark_kind = p.dark_kind;
  if (p.dark_consent) row.d_dark_consent = p.dark_consent;
  if (p.voyeur) row.d_voyeur = p.voyeur;

  // notification preference (chosen on success page — copied to users.notification_preference on signup)
  if (p.notification_preference_choice) {
    row.notification_preference_choice = p.notification_preference_choice;
  }

  // attribution / device
  if (p.fbclid) row.fbclid = p.fbclid;
  if (p.fbc) row.fbc = p.fbc;
  if (p.funnel_version) row.funnel_version = p.funnel_version;
  if (p.landing_page) row.landing_page = p.landing_page;
  if (p.user_agent) row.user_agent = p.user_agent;
  if (p.device_type) row.device_type = p.device_type;

  // event-specific flags
  if (event === "email_capture") {
    row.status = "email_captured";
    row.email_captured_at = new Date().toISOString();
  } else if (event === "plan_selected") {
    // status stays at email_captured; plan is set above
  }
  // NOTE: "payment_successful" is analytics only. Actual paid state is set by
  // stripe-webhook on invoice.paid — never trust the browser for money.

  const { error: upsertErr } = await db
    .from("quiz2_sessions")
    .upsert(row, { onConflict: "id" });

  if (upsertErr) {
    console.error("submit-quiz2 upsert failed:", upsertErr);
    return jsonResponse({ error: "DB upsert failed", detail: upsertErr.message }, 500);
  }

  return jsonResponse({ ok: true });
});
