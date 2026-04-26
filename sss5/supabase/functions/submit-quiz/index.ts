// POST /functions/v1/submit-quiz
//
// Called from the public quiz page (anon key, no JWT verification).
// Handles three event types from the funnel:
//   - "email_capture"      : user submits the email step (we have all quiz answers + email)
//   - "plan_selected"      : user picked a checkout plan
//   - "payment_successful" : fake payment "succeeded" — kicks off chapter 1 generation
//
// Body shape:
//   {
//     session_id: string,         // client-side UUID, used as quiz_sessions.id
//     event: "email_capture" | "plan_selected" | "payment_successful",
//     payload: { ...event-specific fields }
//   }

import { adminClient } from "../_shared/db.ts";
import { corsHeaders, handlePreflight, jsonResponse } from "../_shared/cors.ts";

interface QuizPayload {
  // identity / contact
  email?: string;
  plan?: string;

  // quiz answers
  character?: string;
  feeling?: string;
  fantasy?: string;
  power?: string;
  emotion?: string;
  start?: string;
  missing?: string;
  romance_type?: string;
  experience?: string;
  reason?: string;
  spicy_trigger?: string; // "||"-joined on the wire

  intense?: string;
  explicit?: string;
  explore?: string;
  relationship?: string;

  // attribution / device
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

  let body: { session_id?: string; event?: string; payload?: QuizPayload };
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
  if (p.email)             row.email = p.email;
  if (p.plan)              row.plan = p.plan;

  // quiz answers
  if (p.character)         row.q_character     = p.character;
  if (p.feeling)           row.q_feeling       = p.feeling;
  if (p.fantasy)           row.q_fantasy       = p.fantasy;
  if (p.power)             row.q_power         = p.power;
  if (p.emotion)           row.q_emotion       = p.emotion;
  if (p.start)             row.q_start         = p.start;
  if (p.missing)           row.q_missing       = p.missing;
  if (p.romance_type)      row.q_romance_type  = p.romance_type;
  if (p.experience)        row.q_experience    = p.experience;
  if (p.reason)            row.q_reason        = p.reason;
  if (p.spicy_trigger)     row.q_spicy_trigger = p.spicy_trigger.split("||").filter(Boolean);
  if (p.intense)           row.q_intense       = p.intense;
  if (p.explicit)          row.q_explicit      = p.explicit;
  if (p.explore)           row.q_explore       = p.explore;
  if (p.relationship)      row.q_relationship  = p.relationship;

  // attribution
  if (p.fbclid)            row.fbclid          = p.fbclid;
  if (p.fbc)               row.fbc             = p.fbc;
  if (p.funnel_version)    row.funnel_version  = p.funnel_version;
  if (p.landing_page)      row.landing_page    = p.landing_page;
  if (p.user_agent)        row.user_agent      = p.user_agent;
  if (p.device_type)       row.device_type     = p.device_type;

  // event-specific flags
  if (event === "email_capture") {
    row.status = "email_captured";
    row.email_captured_at = new Date().toISOString();
  } else if (event === "plan_selected") {
    // status stays at email_captured; plan field is set above
  } else if (event === "payment_successful") {
    row.paid = true;
    row.payment_at = new Date().toISOString();
    row.status = "paid";
  }

  const { error: upsertErr } = await db
    .from("quiz_sessions")
    .upsert(row, { onConflict: "id" });

  if (upsertErr) {
    console.error("upsert failed:", upsertErr);
    return jsonResponse({ error: "DB upsert failed", detail: upsertErr.message }, 500);
  }

  // --- On payment, queue chapter 1 generation (fire-and-forget) -------
  if (event === "payment_successful") {
    // 1) Create the story row up front so we have an id to pass.
    const { data: session, error: sErr } = await db
      .from("quiz_sessions")
      .select("email")
      .eq("id", sessionId)
      .single();

    if (sErr || !session?.email) {
      console.error("payment_successful but no session email:", sErr);
      return jsonResponse({ ok: true, warning: "no email on session, chapter not queued" });
    }

    const { data: story, error: stErr } = await db
      .from("stories")
      .insert({
        session_id: sessionId,
        lead_email: session.email,
        status: "pending",
      })
      .select("id")
      .single();

    if (stErr || !story) {
      console.error("story insert failed:", stErr);
      return jsonResponse({ error: "story insert failed", detail: stErr?.message }, 500);
    }

    // 2) Trigger generate-chapter in the background. EdgeRuntime.waitUntil
    //    keeps the worker alive until the fetch settles, but we don't block
    //    the user's response on it.
    const generateUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/generate-chapter`;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const trigger = fetch(generateUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        story_id: story.id,
        target_chapter_number: 1,
      }),
    }).catch((e) => console.error("background generate-chapter failed:", e));

    // @ts-ignore - EdgeRuntime is a Supabase global
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(trigger);
    }

    return jsonResponse({ ok: true, story_id: story.id });
  }

  return jsonResponse({ ok: true });
});
