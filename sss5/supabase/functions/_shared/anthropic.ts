// Thin wrapper around Anthropic's Messages API for Claude Sonnet 4.6.

const MODEL = "claude-sonnet-4-6";
const API = "https://api.anthropic.com/v1/messages";

export async function callClaude(opts: {
  system?: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY env var");

  const body = {
    model: MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature ?? 0.85,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  };

  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = await res.json();
  // Messages API returns { content: [{ type: "text", text: "..." }, ...] }
  const text = (data.content ?? [])
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { text: string }) => c.text)
    .join("\n");
  if (!text) throw new Error("Anthropic returned no text content");
  return text;
}
