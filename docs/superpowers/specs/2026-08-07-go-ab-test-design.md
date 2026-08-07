# PostHog A/B test at `/go` — v1 vs v2 landing page

**Date:** 2026-08-07
**Status:** Approved, ready for implementation planning

## Problem

The two landing pages (`/` = v1, `/2/` = v2) are currently split by **Meta's ad-level A/B
Test**, which randomises across two ad destinations. PostHog does not assign anything; it only
*reports* which arm a visitor landed in, derived from the URL path in `assets/posthog.js`:

```js
const FUNNEL_VARIANT = /^\/(2|quiz2)(\/|$)/.test(location.pathname) ? "v2" : "v1";
```

This has three problems:

1. **Assignment lives outside the analytics tool.** Meta decides the split; PostHog cannot
   report significance, cannot change the ratio, and cannot ship a winner.
2. **Two ad destinations means two sets of creative, budget, and reporting** to keep in sync.
3. **The reporting is only ~40% complete.** Measured over 14 days on `stuffsosweet.com`:

   | Path | Untagged `$pageview` | Tagged `$pageview` |
   |---|---|---|
   | `/` | 1,775 | 1,044 |
   | `/quiz/a.html` | 1,500 | 709 |
   | `/2/` | 52 | 133 |
   | `/quiz2/` | 69 | 75 |

   Every path shows the same pattern because `posthog.init({capture_pageview: true})` fires the
   first `$pageview` *during* init, before `posthog.register({funnel_variant})` runs on the next
   line. The current Meta A/B read is on a partial sample.

## Goal

One ad destination — `stuffsosweet.com/go` — that **renders** either the v1 or the v2 homepage,
with PostHog owning assignment as a real Experiment measured on purchases.

`/go` **replaces** the Meta split: all ads point at `/go`, Meta stops splitting. `/` and `/2/`
remain directly reachable and keep their existing path-derived `funnel_variant` behaviour.

## Non-goals

- Changing either landing page's content, copy, or design.
- Changing the quizzes, the checkout, or the app.
- Putting `/` itself into the experiment. Only `/go` is split.

## Constraints established during exploration

- `sss-home` is a **static Cloudflare Pages site** with two deploy paths: the Git integration
  running `cf-build.sh` → `_site`, and manual `deploy-cf.sh` → `wrangler pages deploy`.
- There are currently **no Pages Functions, no `_redirects`, no `_worker.js`** on this project.
- Both landing pages reference assets by **absolute path** (`/media/...` and `/2/media/...`),
  verified. This is what makes serving v2's HTML bytes from `/go` viable — no relative URL
  resolves differently.
- Cloudflare Pages currently serves `index.html` for unknown paths, so `/go`, `/belelkas`, and
  `/uhuhh` all already render v1 today. A Pages Function takes precedence over that fallback,
  so this is a clean override with no 404 risk.
- The SSS PostHog project (207201, EU) has **zero feature flags** — clean namespace.
- Events `subscription_started`, `funnel_email_capture`, `quiz_started`, and `cta_get_started`
  all exist and are confirmed against the live project schema.

## Approach

A **Cloudflare Pages Function** at `/go` evaluates the PostHog flag server-side, serves the
winning page's HTML at `/go`, and bootstraps posthog-js with the decision so the browser never
re-rolls.

Rejected alternatives:

- **Client-side redirect from `/go` to `/` or `/2/`.** Simplest to ship, but the URL doesn't
  stay at `/go` and there is a 300–800ms blank interstitial on mobile. Bounces during that
  interstitial correlate with the arm, which biases the experiment being measured.
- **Coin flip at the edge instead of calling PostHog.** Faster and outage-proof, but PostHog
  stops being the source of truth: no adjustable split, no targeting, no ship-a-winner. It
  reimplements a feature flag that already exists.

PostHog's own docs point this direction: for edge/lambda environments they recommend the
`/flags` endpoint over local evaluation, and `bootstrap` specifically "prevents flicker and
enables startup logic, such as redirects, to use flags before the SDK finishes its first
`/flags` request."

## Architecture

### Request flow

```
GET /go?fbclid=…
  └─ functions/go.js  (Pages Function, edge)
       1. bot UA?  ─────────────► serve /index.html · no cookie · no exposure
       2. ?force=control|test ──► serve that arm · no exposure   (QA override)
       3. resolve distinct_id (see below)
       4. POST https://eu.i.posthog.com/flags?v=2   { api_key, distinct_id }   [600ms timeout]
       5. timeout / error / no variant ──► serve /index.html · no exposure
                                           (visitor excluded from the experiment entirely)
       6. "control" → /index.html    "test" → /2/index.html
          via env.ASSETS.fetch()
       7. HTMLRewriter prepends <script>window.__SSS_EXP__ = {…}</script> into <head>
       8. respond at /go with Cache-Control: no-store, X-Robots-Tag: noindex
```

Excluding on error rather than defaulting to control keeps the sample unbiased — a PostHog
outage removes visitors from the experiment instead of silently stuffing one arm.

### Identity

The edge and the browser must agree on `distinct_id`, or they assign independently and disagree
about half the time. Resolution order:

1. Existing posthog-js cookie `ph_phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu_posthog` →
   parse its JSON, take `.distinct_id`. A returning visitor keeps the identity PostHog already
   knows, so no forked person is created.
2. Else our own `sss_did` cookie.
3. Else mint `crypto.randomUUID()` and set
   `sss_did=…; Max-Age=31536000; Path=/; Secure; SameSite=Lax`.

The resolved id is passed to the client as `bootstrap.distinctID`, so assignment is sticky
across visits and identical on both sides.

### Injected payload

```html
<script>window.__SSS_EXP__={flag:"landing-go",variant:"test",distinctId:"…",arm:"v2"};</script>
```

Prepended into `<head>` with `HTMLRewriter` (streaming, no full-body buffering). It is a plain
inline script and `/assets/posthog.js` is `type="module"` (deferred), so ordering is guaranteed
regardless of position within `<head>`.

`arm` carries the existing `v1`/`v2` vocabulary so `/go` data stays comparable with the
historical Meta-split data.

### Changes to `assets/posthog.js`

```js
const EXP = window.__SSS_EXP__ || null;               // present only on /go

const FUNNEL_VARIANT = EXP ? EXP.arm
  : (/^\/(2|quiz2)(\/|$)/.test(location.pathname) ? "v2" : "v1");

posthog.init(POSTHOG_KEY, {
  …existing options…,
  capture_pageview: false,                            // §9 fix — see below
  bootstrap: EXP ? { distinctID: EXP.distinctId,
                     featureFlags: { [EXP.flag]: EXP.variant } } : undefined,
});

posthog.register({ surface: "marketing", funnel_variant: FUNNEL_VARIANT });
posthog.capture("$pageview");                         // §9 fix — now carries the super props
if (EXP) posthog.getFeatureFlag(EXP.flag);            // fires $feature_flag_called = exposure
```

`getFeatureFlag()` is load-bearing. PostHog counts a user as *in* the experiment only on
receipt of `$feature_flag_called` carrying `$feature_flag` and `$feature_flag_response`;
bootstrapping alone does not emit it.

Once a flag value is known, posthog-js also stamps `$feature/landing-go` onto **every**
subsequent event automatically. Because bootstrap makes it known at init time, that tagging does
not inherit the ordering race described in the Problem section.

### Downstream — unchanged

Neither landing page needs editing. Both CTA scripts read `window.location.search` at runtime:

- v1 forwards to `/quiz/a` + the query string.
- v2 forwards to `/quiz2/?…&src=v2landing`.

So `/go?fbclid=x` forwards attribution correctly from either arm. After the click the visitor is
on `/quiz/a` or `/quiz2/`, where the existing path regex resolves the same arm, and the two
quizzes already write to separate tables (`quiz_sessions` / `quiz2_sessions`). The split
survives into the database with no changes. v2's `?background=N` and `?debug=1` params keep
working at `/go` too.

## PostHog configuration

| | |
|---|---|
| Flag key | `landing-go` |
| Variants | `control` → `/index.html` (v1) · `test` → `/2/index.html` (v2) |
| Split | 50 / 50, 100% of traffic targeted |
| Exposure event | default `$feature_flag_called` |
| Primary metric | `subscription_started`, unique users — captured server-side by `stripe-webhook`, so ad-blockers cannot suppress it |
| Secondary metrics | `funnel_email_capture`, `quiz_started`, `cta_get_started` |

`control` is a fixed variant name in PostHog; the code must use exactly `control` and `test`.

Created through the PostHog API so the key and variant names match the shipped code exactly.

**Identity stitching works for the primary metric.** Exposure fires anonymously on `/go`.
`assets/posthog.js` calls `identify(email)` at `funnel_email_capture`, merging the anonymous
distinct_id into the email-keyed person. `stripe-webhook` then captures `subscription_started`
with that same lowercased email as `distinctId`. Exposure precedes conversion in time, which
PostHog requires — metric events before first exposure are discarded.

## Caching, bots, SEO

- **`Cache-Control: no-store` on the `/go` response is non-negotiable.**
  `env.ASSETS.fetch()` returns the underlying asset's headers; if a variant response were ever
  stored at the edge, one visitor's arm would be served to everyone behind that POP and the
  experiment would be void. The Function must overwrite the headers, not pass them through.
- `X-Robots-Tag: noindex` on `/go`. Deliberately **no** `robots.txt` Disallow — blocking the
  crawl would prevent the header from ever being read.
- Bot short-circuit on user-agent (`facebookexternalhit`, `Twitterbot`, `Slackbot`, `WhatsApp`,
  `Googlebot`, `bingbot`, headless). Serves control, no cookie, no exposure. This keeps crawlers
  out of the sample and keeps the Facebook ad link-preview stable — without it, the preview card
  would flip between v1's and v2's `og:image` on every scrape.
- `/go/` (trailing slash) → `_redirects` entry to `/go`, query string preserved.

## Deployment

Cloudflare's docs are explicit: *"Make sure that the `/functions` directory is at the root of
your Pages project (and not in the static root, such as `/dist`)."*

- `functions/go.js` lives at `sss-home/functions/go.js`.
- **`cf-build.sh` must add `functions` to its prune list**, alongside `docs/` and `sss5/`.
  It currently does `cp -a . "$STAGE/"` and copies the result into `_site`, which would publish
  `go.js` as a downloadable static file at `/functions/go.js`.
- **`deploy-cf.sh` needs empirical verification.** Cloudflare documents that
  `wrangler pages functions build` compiles `functions/`, but does *not* document whether
  `wrangler pages deploy <dir>` picks it up, and wrangler 4.120 exposes no
  `--functions-directory` flag. Ship via the Git integration first — the path `cf-build.sh`
  documents as primary — confirm on a **preview branch deployment** that `/go` is served by the
  Function and not the SPA fallback, then adjust `deploy-cf.sh`. Documented fallback if implicit
  pickup does not work: `wrangler pages functions build` → `_worker.js`.

## Testing

- `?force=control` / `?force=test` override, which **skips the exposure event** so QA traffic
  never enters the experiment.
- Local: `npx wrangler pages dev .` runs Functions locally.

Verification checklist:

1. Both arms render with correct imagery — v2 must pull `/2/media/d3.webp`, its default
   background.
2. `window.__SSS_EXP__` present in the served DOM.
3. `$feature_flag_called` appears in PostHog live events with the matching
   `$feature_flag_response`.
4. Same arm on reload and on a later visit (cookie stickiness).
5. `/go?fbclid=x` forwards `fbclid` into the quiz URL from both arms.
6. A bot user-agent receives control, no `Set-Cookie`, no exposure.
7. With posthog blocked by an ad-blocker, `/go` still renders a complete page.
8. Response carries `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
9. `/go/` redirects to `/go` with the query string intact.
10. After the §9 fix, `$pageview` on `/`, `/2/`, and `/go` carries `funnel_variant` — verify the
    untagged share drops toward zero.

## What this experiment can and cannot resolve

Measured over the last 6 weeks: **~1,500 landing views/week, ~30 `subscription_started`/week —
a ~2% purchase rate.**

| Real difference | Visitors needed | Time at current traffic |
|---|---|---|
| +20% relative (2.0% → 2.4%) | ~39,000 | ~26 weeks |
| +50% relative (2.0% → 3.0%) | ~6,300 | ~4 weeks |
| +100% relative (2.0% → 4.0%) | ~1,600 | ~1 week |

Purchase is the correct business metric and stays primary. At this traffic it can only resolve a
**large** difference — roughly ≥50% relative — inside a month. `funnel_email_capture` runs at a
~21% baseline and should reach significance in about two weeks; treat it as the early read.
These timelines compress proportionally if `/go` carries more ad spend than `/` and `/2/` did.

## §9 — folded-in fix: `funnel_variant` tagging race

Approved as part of this change. In `assets/posthog.js`, set `capture_pageview: false` in
`init()`, then `register()`, then `posthog.capture("$pageview")`.

This affects every marketing page, not just `/go`. It is in scope because the same race would
leave `/go`'s pageview untagged 60% of the time.

Historical data keeps the gap; only events after deploy are corrected.

## Files touched

| File | Change |
|---|---|
| `functions/go.js` | New — the Pages Function |
| `_redirects` | New — `/go/` → `/go` |
| `assets/posthog.js` | Bootstrap, exposure call, `arm` handling, §9 pageview fix |
| `cf-build.sh` | Add `functions` to the prune list |
| `deploy-cf.sh` | Adjust after preview-deploy verification |
| PostHog project 207201 | New `landing-go` flag + Experiment |

`index.html` and `2/index.html` are **not** modified.
