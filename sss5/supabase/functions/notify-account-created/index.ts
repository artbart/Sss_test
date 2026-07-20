// POST /functions/v1/notify-account-created
//
// Target of the pg_net database webhook that fires AFTER INSERT on
// public.users (see migrations/20260720_account_created_webhook.sql) — i.e.
// on account creation via handle_new_auth_user. Authenticated by a shared
// secret header (ACCOUNT_WEBHOOK_SECRET), NOT JWT.
//
// Always returns 200 once authenticated: a failed Slack post must not make
// pg_net retry-spam. Only `record.email` is read — no other PII goes to Slack.

import { notifySlack } from "../_shared/slack.ts";

const SECRET = Deno.env.get("ACCOUNT_WEBHOOK_SECRET");

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!SECRET) return new Response("ACCOUNT_WEBHOOK_SECRET not set", { status: 503 });
  if (req.headers.get("x-webhook-secret") !== SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    const body = await req.json() as { record?: { email?: string } };
    await notifySlack({ kind: "account_created", email: body?.record?.email ?? null });
  } catch (e) {
    console.error("notify-account-created failed:", e);
  }
  return new Response("ok", { status: 200 });
});
