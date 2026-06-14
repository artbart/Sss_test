// Resend email helper. The sender domain (currently stuffsosweet.com, future
// stuffsosweet.com) must be verified in Resend before this works for arbitrary
// recipients. Until verified, Resend only sends to the account email.

const API = "https://api.resend.com/emails";

// Brand display name shown as the "From" name in users' inboxes. Hardcoded
// because it's a product decision, not a config one — same value in every
// environment. Update here, redeploy, done.
const FROM_NAME = "Stuff So Sweet";

export interface SendEmailArgs {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(args: SendEmailArgs): Promise<void> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  const from = Deno.env.get("MAIL_FROM") ?? "stories@stuffsosweet.com";
  const fromName = FROM_NAME;
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
