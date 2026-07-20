// POST /functions/v1/notify-account-created
//
// Target of the pg_net database webhook that fires AFTER INSERT on
// public.users (see migrations/20260720_account_created_webhook.sql) — i.e.
// on account creation via handle_new_auth_user. Authenticated by a shared
// secret header (ACCOUNT_WEBHOOK_SECRET), NOT JWT.
//
// Always returns 200 once authenticated: a failed Slack post must not make
// pg_net retry-spam. Only `record.email` is read — no other PII goes to Slack.
// The Slack send runs via EdgeRuntime.waitUntil so the short-timeout pg_net
// caller never waits on it.

import { notifySlack } from "../_shared/slack.ts";

const SECRET = Deno.env.get("ACCOUNT_WEBHOOK_SECRET");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SECRET) return new Response("ACCOUNT_WEBHOOK_SECRET not set", { status: 503 });
  if (req.headers.get("x-webhook-secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Parse, then fire-and-forget: the pg_net caller has a short timeout, so
  // never make it wait on the Slack round-trip (a cold start + Slack API can
  // exceed it and the alert would be silently dropped mid-flight).
  let email: string | null = null;
  try {
    const body = await req.json() as { record?: { email?: string } };
    email = body?.record?.email ?? null;
  } catch (e) {
    console.error("notify-account-created: bad payload:", e);
  }
  const send = notifySlack({ kind: "account_created", email })
    .catch((e) => console.error("notify-account-created failed:", e));
  // @ts-ignore EdgeRuntime is a Supabase global
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) EdgeRuntime.waitUntil(send);
  else await send; // local dev fallback
  return new Response("ok", { status: 200 });
});
