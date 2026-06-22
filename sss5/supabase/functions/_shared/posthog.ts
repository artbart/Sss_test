// PostHog server-side capture — subscription lifecycle conversions.
//
// The Stripe webhook is the source of truth for revenue, so the authoritative
// purchase/renewal/cancellation events are captured here (server-side), keyed
// on the customer's EMAIL — the same distinct_id the marketing funnel and the
// app use, so these events land on the SAME PostHog person.
//
// Uses a raw fetch to PostHog's /capture/ endpoint (no SDK) so there is no
// batching/flush/shutdown lifecycle to manage in the ephemeral edge runtime.
//
// The key is PUBLIC (publishable) — same key shipped in the browser. Override
// via the POSTHOG_KEY secret if desired. Fire-and-forget; never throws (callers
// must not fail fulfillment on an analytics error).

const POSTHOG_KEY = Deno.env.get("POSTHOG_KEY") ?? "phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu";
const POSTHOG_HOST = Deno.env.get("POSTHOG_HOST") ?? "https://eu.i.posthog.com";

export interface PosthogCaptureInput {
  event: string;
  distinctId: string | null | undefined; // prefer email; falls back below
  properties?: Record<string, unknown>;
}

export async function capturePosthog(i: PosthogCaptureInput): Promise<void> {
  if (!POSTHOG_KEY || !POSTHOG_KEY.startsWith("phc_")) {
    console.log("POSTHOG_KEY not set — skipping PostHog capture");
    return;
  }
  const distinct_id = i.distinctId || "anonymous_server";
  try {
    const res = await fetch(`${POSTHOG_HOST}/capture/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: POSTHOG_KEY,
        event: i.event,
        distinct_id,
        properties: { ...(i.properties ?? {}), surface: "server", source: "stripe-webhook" },
      }),
    });
    if (!res.ok) {
      console.error("PostHog capture failed:", res.status, await res.text().catch(() => ""));
    } else {
      console.log("PostHog capture sent:", i.event, distinct_id);
    }
  } catch (e) {
    console.error("PostHog capture error:", e);
  }
}
