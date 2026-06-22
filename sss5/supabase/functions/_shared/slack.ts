// Slack notifications for subscription lifecycle events.
//
// Reuses the shared Slack bot from the my-photo-alive setup (SLACK_BOT_TOKEN)
// and posts to a dedicated channel (SLACK_CHANNEL_PURCHASES). The bot must be a
// member of that channel. No-ops gracefully until both are set, so it is safe
// to deploy before the secrets exist.
//
// Fire-and-forget; never throws (callers must not fail fulfillment on a
// notification error).

const TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
const CHANNEL = Deno.env.get("SLACK_CHANNEL_PURCHASES");

type SlackEventKind = "purchase" | "renewal" | "payment_failed" | "cancellation";

const META: Record<SlackEventKind, { icon: string; title: string }> = {
  purchase: { icon: "🎉", title: "New purchase" },
  renewal: { icon: "🔁", title: "Subscription renewed" },
  payment_failed: { icon: "❌", title: "Payment failed" },
  cancellation: { icon: "👋", title: "Subscription canceled" },
};

export interface SlackNotifyInput {
  kind: SlackEventKind;
  email?: string | null;
  amount?: number | null; // major units (e.g. dollars), not cents
  currency?: string | null;
  sessionId?: string | null;
  customerId?: string | null;
  fields?: Record<string, string | number | boolean | null | undefined>;
}

export async function notifySlack(i: SlackNotifyInput): Promise<void> {
  if (!TOKEN || !CHANNEL) {
    console.log("SLACK_BOT_TOKEN / SLACK_CHANNEL_PURCHASES not set — skipping Slack notify");
    return;
  }

  const m = META[i.kind];
  const lines: string[] = [];
  if (i.email) lines.push(`*Email:* ${i.email}`);
  if (i.amount != null) {
    lines.push(`*Amount:* ${i.amount.toFixed(2)} ${(i.currency || "USD").toUpperCase()}`);
  }
  if (i.sessionId) lines.push(`*Session:* \`${i.sessionId}\``);
  if (i.customerId) lines.push(`*Customer:* \`${i.customerId}\``);
  for (const [k, v] of Object.entries(i.fields ?? {})) {
    if (v != null && v !== "") lines.push(`*${k}:* ${v}`);
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: CHANNEL,
        text: `${m.icon} ${m.title}`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: `${m.icon} ${m.title}`, emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: lines.join("\n") || "_no details_" } },
        ],
      }),
    });
    const payload = (await res.json()) as { ok?: boolean; error?: string };
    if (!payload.ok) console.error("Slack notify error:", payload.error);
    else console.log("Slack notify sent:", i.kind, i.email ?? "");
  } catch (e) {
    console.error("Slack notify failed:", e);
  }
}
