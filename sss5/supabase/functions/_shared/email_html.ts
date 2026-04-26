// Builds the HTML body of a chapter email.
//
// chapterUrlBase: e.g. "https://savageshopper.com/sss5/chapter.html"
// We append `?story_id=...&chapter=N&option=1|2|3` for each link.

export interface ChapterEmailArgs {
  storyTitle: string;
  chapterNumber: number;
  totalChapters: number;
  chapterText: string;
  options: [string, string, string];
  storyId: string;
  chapterUrlBase: string;
  isFinalChapter: boolean;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function paragraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6;">${escapeHtml(p.trim()).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export function buildChapterEmail(args: ChapterEmailArgs): { subject: string; html: string; text: string } {
  const {
    storyTitle, chapterNumber, totalChapters, chapterText,
    options, storyId, chapterUrlBase, isFinalChapter,
  } = args;

  const subject = `${storyTitle} — Chapter ${chapterNumber} of ${totalChapters}`;

  const optionLink = (i: 1 | 2 | 3) =>
    `${chapterUrlBase}?story_id=${encodeURIComponent(storyId)}&chapter=${chapterNumber}&option=${i}`;

  const optionButton = (i: 1 | 2 | 3, label: string) => `
    <tr><td style="padding:6px 0;">
      <a href="${optionLink(i)}"
         style="display:block;background:#e04b57;color:#ffffff;text-decoration:none;
                text-align:left;padding:14px 18px;border-radius:12px;font-family:Georgia,serif;
                font-size:15px;line-height:1.4;">
        <strong>Option ${i}.</strong> ${escapeHtml(label)}
      </a>
    </td></tr>
  `;

  const optionsBlock = isFinalChapter
    ? `<p style="margin:24px 0 0;font-style:italic;opacity:0.85;">
        This was the final chapter of your story. We hope you enjoyed it.
       </p>`
    : `
      <p style="margin:24px 0 8px;font-family:Georgia,serif;font-size:16px;">
        <strong>Choose what happens next:</strong>
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${optionButton(1, options[0])}
        ${optionButton(2, options[1])}
        ${optionButton(3, options[2])}
      </table>
    `;

  const html = `<!DOCTYPE html>
<html><body style="margin:0;background:#1a0008;color:#ffffff;font-family:Georgia,serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:linear-gradient(180deg,#4b0018,#1a0008);">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td style="text-align:center;font-size:22px;font-weight:bold;padding-bottom:10px;letter-spacing:0.5px;">
          My Hidden Story
        </td></tr>
        <tr><td style="text-align:center;font-size:14px;opacity:.75;padding-bottom:24px;">
          Chapter ${chapterNumber} of ${totalChapters}
        </td></tr>
        <tr><td style="background:rgba(255,255,255,0.06);border-radius:18px;padding:24px;">
          <h1 style="margin:0 0 16px;font-size:22px;font-weight:normal;color:#f0d48c;">
            ${escapeHtml(storyTitle)}
          </h1>
          ${paragraphs(chapterText)}
          ${optionsBlock}
        </td></tr>
        <tr><td style="text-align:center;font-size:11px;opacity:.55;padding-top:24px;line-height:1.5;">
          You're receiving this because you started a personalized story at My Hidden Story.<br>
          This is an automated message — please don't reply directly.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text = `${storyTitle} — Chapter ${chapterNumber} of ${totalChapters}\n\n${chapterText}\n\n` +
    (isFinalChapter
      ? "This was the final chapter of your story.\n"
      : `Choose what happens next:\n\n` +
        `1. ${options[0]}\n   ${optionLink(1)}\n\n` +
        `2. ${options[1]}\n   ${optionLink(2)}\n\n` +
        `3. ${options[2]}\n   ${optionLink(3)}\n`);

  return { subject, html, text };
}
