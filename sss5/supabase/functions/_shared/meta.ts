// Meta Conversions API (CAPI) — server-side Purchase mirror.
//
// Sends a server-side "Purchase" that Meta deduplicates against the browser
// Pixel event via a shared event_id. No-ops gracefully until META_CAPI_TOKEN
// is set, so it is safe to deploy before the token exists.

const PIXEL_ID = Deno.env.get("META_PIXEL_ID") ?? "2011659879327902";
const GRAPH_VERSION = "v18.0";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input.trim().toLowerCase());
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CapiPurchaseInput {
  eventId: string;
  email: string;
  value: number;
  currency: string;
  fbc?: string | null;
  fbp?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  sourceUrl?: string | null;
  eventTimeSec?: number;
}

// Fire-and-forget; never throws (callers shouldn't fail fulfillment on a
// marketing pixel error).
export async function sendCapiPurchase(i: CapiPurchaseInput): Promise<void> {
  const token = Deno.env.get("META_CAPI_TOKEN");
  if (!token) {
    console.log("META_CAPI_TOKEN not set — skipping CAPI Purchase");
    return;
  }
  if (!i.eventId) {
    console.log("no meta event_id on subscription — skipping CAPI Purchase");
    return;
  }

  const user_data: Record<string, unknown> = {};
  if (i.email) user_data.em = [await sha256Hex(i.email)];
  if (i.clientIp) user_data.client_ip_address = i.clientIp;
  if (i.userAgent) user_data.client_user_agent = i.userAgent;
  if (i.fbc) user_data.fbc = i.fbc;
  if (i.fbp) user_data.fbp = i.fbp;

  const payload = {
    data: [{
      event_name: "Purchase",
      event_time: i.eventTimeSec ?? Math.floor(Date.now() / 1000),
      event_id: i.eventId,
      action_source: "website",
      event_source_url: i.sourceUrl ?? "https://stuffsosweet.com/quiz/a.html",
      user_data,
      custom_data: { currency: (i.currency || "USD").toUpperCase(), value: i.value },
    }],
  };

  try {
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("CAPI Purchase failed:", res.status, await res.text());
    } else {
      console.log("CAPI Purchase sent:", i.eventId, `$${i.value}`);
    }
  } catch (e) {
    console.error("CAPI Purchase error:", e);
  }
}
