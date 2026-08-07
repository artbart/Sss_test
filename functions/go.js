// Cloudflare Pages Function for stuffsosweet.com/go
//
// Renders EITHER the v1 homepage (/index.html) or the v2 homepage
// (/2/index.html) at the /go URL, with PostHog deciding which. The URL never
// changes, so ads have one destination instead of two.
//
// WHY the decision happens here and not in the browser: evaluating the flag
// client-side means either painting control first and swapping (a visible
// flash) or painting nothing while the flag loads. Both cost bounces on paid
// mobile traffic, and those bounces correlate with the arm — which would bias
// the very experiment this exists to measure.

const POSTHOG_KEY = "phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu";
const FLAG_KEY = "landing-go";

// Which asset each variant serves, and the v1/v2 vocabulary the rest of the
// funnel already speaks (quiz_sessions vs quiz2_sessions, funnel_variant).
const ARMS = {
  control: { asset: "/index.html", arm: "v1" },
  test: { asset: "/2/index.html", arm: "v2" },
};

// Crawlers and link-preview scrapers always get control and never enter the
// sample. Without this the Facebook ad preview card would flip between v1's
// and v2's og:image on every scrape.
//
// Entries are deliberately crawler-specific. Bare app names like
// "pinterest" or "telegram" also appear in those apps' IN-APP BROWSER
// user-agents, which are real people tapping a link — matching those would
// permanently force real ad visitors into control and silently drop them
// from the sample.
const BOT_RE =
  /bot|crawler|spider|facebookexternalhit|twitterbot|slackbot|whatsapp\/|telegrambot|discordbot|embedly|pinterestbot|headlesschrome|lighthouse|curl\/|wget/i;

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (BOT_RE.test(request.headers.get("user-agent") || "")) {
    return render(env, url, "control", null, null);
  }

  // QA override. Renders the requested arm but flags exposure:false, so manual
  // testing never registers a participant in the experiment.
  const forced = url.searchParams.get("force");
  if (forced === "control" || forced === "test") {
    return render(env, url, forced, payload(forced, null, false), null);
  }

  return render(env, url, "control", null, null); // Task 3 replaces this line
}

function payload(variant, distinctId, exposure) {
  return {
    flag: FLAG_KEY,
    variant,
    distinctId,
    arm: ARMS[variant].arm,
    exposure,
  };
}

async function render(env, url, variant, exp, setCookieId) {
  const asset = new URL(ARMS[variant].asset, url.origin);
  const res = await env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  let html = await res.text();

  if (exp) {
    // A plain inline script. /assets/posthog.js is type="module" and therefore
    // deferred, so this always executes first regardless of where in <head> it
    // lands — which is what lets posthog-js bootstrap from it.
    html = html.replace(
      "</head>",
      `<script>window.__SSS_EXP__=${JSON.stringify(exp)};</script></head>`
    );
  }

  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // NON-NEGOTIABLE. env.ASSETS.fetch() hands back the static asset's own
    // cache headers. Pass those through and Cloudflare caches "the v2 page" as
    // the answer for /go at that POP — everyone behind it gets v2, the split
    // silently collapses, and the experiment still looks like it ran fine.
    "cache-control": "no-store",
    // /go is a duplicate of /. Deliberately NOT also blocked in robots.txt:
    // blocking the crawl would stop this header from ever being read.
    "x-robots-tag": "noindex",
  });
  if (setCookieId) {
    headers.append(
      "set-cookie",
      `sss_did=${setCookieId}; Max-Age=31536000; Path=/; Secure; SameSite=Lax`
    );
  }

  return new Response(html, { status: res.ok ? 200 : res.status, headers });
}
