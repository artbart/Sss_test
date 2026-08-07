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

const FLAGS_TIMEOUT_MS = 600;

// posthog-js writes its identity here (persistence: "localStorage+cookie").
const PH_COOKIE = `ph_${POSTHOG_KEY}_posthog`;

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

  // The edge and the browser MUST agree on distinct_id. If they diverge, the
  // edge renders v2 while posthog-js independently buckets the same person
  // into control, and the experiment quietly measures noise.
  const known = readDistinctId(request);
  const distinctId = known || crypto.randomUUID();

  const variant = await evaluateFlag(env, distinctId);

  // PostHog unreachable, or the flag returned something unexpected: serve
  // control and record NO exposure. The visitor is excluded from the
  // experiment rather than silently stuffed into one arm, which keeps the
  // remaining sample unbiased.
  if (!variant) return render(env, url, "control", null, known ? null : distinctId);

  return render(
    env,
    url,
    variant,
    payload(variant, distinctId, true),
    known ? null : distinctId
  );
}

function readDistinctId(request) {
  const jar = parseCookies(request.headers.get("cookie") || "");

  // Prefer the identity posthog-js already uses. Minting our own for a
  // returning visitor would fork them into a second PostHog person and split
  // their funnel across two distinct_ids.
  const ph = jar[PH_COOKIE];
  if (ph) {
    try {
      const id = JSON.parse(decodeURIComponent(ph)).distinct_id;
      if (typeof id === "string" && id) return id;
    } catch {
      // Malformed cookie — fall through to sss_did.
    }
  }

  return jar.sss_did || null;
}

function parseCookies(header) {
  const jar = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return jar;
}

async function evaluateFlag(env, distinctId) {
  const host = env.POSTHOG_HOST || "https://eu.i.posthog.com";
  try {
    const res = await fetch(`${host}/flags?v=2`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: POSTHOG_KEY, distinct_id: distinctId }),
      signal: AbortSignal.timeout(FLAGS_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = await res.json();
    // v2 envelope, confirmed against the live endpoint:
    //   { errorsWhileComputingFlags, flags: { "landing-go": { variant, … } }, … }
    // The featureFlags fallback covers the older v1 shape.
    const v = json?.flags?.[FLAG_KEY]?.variant ?? json?.featureFlags?.[FLAG_KEY];
    return v === "control" || v === "test" ? v : null;
  } catch {
    // Timeout, DNS failure, PostHog 5xx — all excluded rather than defaulted.
    return null;
  }
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
      `sss_did=${setCookieId}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax`
    );
  }

  return new Response(html, { status: res.ok ? 200 : res.status, headers });
}
