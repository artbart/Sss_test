// Resend email helper. Domain `myhiddenstory.com` must be verified in Resend
// before this works for arbitrary recipients. Until verified, Resend only
// allows sends to your account email (abobinas@gmail.com).

const API = "https://api.resend.com/emails";

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM") ?? "stories@myhiddenstory.com";
  const fromName = Deno.env.get("MAIL_FROM_NAME") ?? "My Hidden Story";
  const replyTo = Deno.env.get("MAIL_REPLY_TO");

  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var");

  const body: Record<string, unknown> = {
    from: `${fromName} <${from}>`,
    to: [args.to],
    subject: args.subject,
    html: args.html,
    text: args.text,
  };
  if (replyTo) body.reply_to = replyTo;

  const res = await fetch(API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend API ${res.status}: ${text.slice(0, 500)}`);
  }
}
