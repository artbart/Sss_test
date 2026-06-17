// POST /functions/v1/auth-create-magic-link
//
// Generates a one-click magic-link URL for a paid quiz session, WITHOUT
// sending an email. Browser then redirects the user directly to the URL —
// they land signed-in inside the app.
//
// Used by the success page's green "Login to Your Account" button. The user
// just paid using THIS email (verified via paid quiz_session), so we can
// safely hand them a signin link without the usual email-proof loop.
//
// Body: { session_id: uuid, email: string, redirect_to?: string }
// Returns: { magic_link_url: string }
//
// Security: refuses if session_id isn't paid OR doesn't match the email.
// Refuses redirect_to URLs outside app.stuffsosweet.com (prevents open-redirect
// token harvesting).

import { handlePreflight, jsonResponse } from "../_shared/cors.ts";
import { adminClient } from "../_shared/db.ts";

const APP_ORIGIN = "https://app.stuffsosweet.com";
const DEFAULT_REDIRECT = `${APP_ORIGIN}/auth/callback?next=/stories.html`;

function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    // Must be on the app domain. Anything else would be a vulnerability.
    return u.origin === APP_ORIGIN;
  } catch (_) {
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const pre = handlePreflight(req); if (pre) return pre;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: { session_id?: string; email?: string; redirect_to?: string };
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const sessionId = (body.session_id ?? "").trim();
  const email = (body.email ?? "").trim().toLowerCase();
  let redirectTo = (body.redirect_to ?? "").trim();

  if (!sessionId || !email) {
    return jsonResponse({ error: "Missing session_id or email" }, 400);
  }

  // Sanitize redirect: only the app origin, default if missing/unsafe.
  if (!redirectTo || !isSafeRedirect(redirectTo)) {
    redirectTo = DEFAULT_REDIRECT;
  }

  const db = adminClient();

  // Verify session: must be paid AND must match the email.
  const { data: session, error: sErr } = await db
    .from("quiz_sessions")
    .select("id, email, paid")
    .eq("id", sessionId)
    .maybeSingle();

  if (sErr) {
    console.error("[auth-create-magic-link] session lookup failed:", sErr);
    return jsonResponse({ error: "Could not verify session" }, 500);
  }
  if (!session) {
    return jsonResponse({ error: "Session not found" }, 404);
  }
  if (!session.paid) {
    return jsonResponse({ error: "Session not paid" }, 403);
  }
  if ((session.email ?? "").toLowerCase() !== email) {
    return jsonResponse({ error: "Email does not match session" }, 403);
  }

  // Generate magic-link URL. admin.generateLink returns the action_link
  // WITHOUT triggering the auth-email-hook (which only fires for explicit
  // email-sending operations like signInWithOtp).
  const { data, error: linkErr } = await db.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: {
      redirectTo,
    },
  });

  if (linkErr || !data?.properties?.action_link) {
    console.error("[auth-create-magic-link] generateLink failed:", linkErr);
    return jsonResponse({ error: "Could not create sign-in link" }, 500);
  }

  console.log(`[auth-create-magic-link] issued magic link for ${email} -> ${redirectTo}`);
  return jsonResponse({ magic_link_url: data.properties.action_link });
});
