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
3. ~~**The reporting is only ~40% complete**, due to an init/register ordering race.~~
   **Corrected 2026-08-07 (Task 5 fix round 1): this was never true.** The original ~60%
   untagged figure aggregated pageviews from before and after 2026-07-31, the date
   `funnel_variant` first shipped — every event before that date lacks the property because it
   did not exist yet, not because of any race. Verified by SQL: 0% tagged before 2026-08-01,
   ~99% tagged from 2026-08-01 onward, with the residual gap decaying 63 → 10 → 8 → 1 as stale
   cached copies of the old script expire. It is also disproven directly: 100% of the untagged
   events still carry `surface`, the sibling property set by the *same* `register()` call — an
   ordering race would have dropped both or neither. posthog-js has deferred its init pageview
   by a macrotask (`setTimeout(…, 1)`) since ~1.130, and `register()` runs synchronously before
   that macrotask fires, so there was never a race to begin with. See the corrected §9 below;
   the `capture_pageview: false` change this section originally justified has been reverted.

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

const FUNNEL_VARIANT = EXP && (EXP.arm === "v1" || EXP.arm === "v2") ? EXP.arm
  : (/^\/(2|quiz2)(\/|$)/.test(location.pathname) ? "v2" : "v1");

// True only when posthog-js already holds an identity of its own.
const hasPhIdentity = document.cookie.indexOf(`ph_${POSTHOG_KEY}_posthog=`) !== -1;

posthog.init(POSTHOG_KEY, {
  …existing options…,
  capture_pageview: true,                             // unchanged — see corrected §9 below
  bootstrap: EXP ? {
    featureFlags: { [EXP.flag]: EXP.variant },
    // distinctID only when posthog-js has no identity of its own — see corrected §9.
    ...(EXP.distinctId && !hasPhIdentity ? { distinctID: EXP.distinctId } : {}),
  } : undefined,
});

posthog.register({ surface: "marketing", funnel_variant: FUNNEL_VARIANT });
if (EXP && EXP.exposure) posthog.getFeatureFlag(EXP.flag); // fires $feature_flag_called = exposure
```

`getFeatureFlag()` is load-bearing. PostHog counts a user as *in* the experiment only on
receipt of `$feature_flag_called` carrying `$feature_flag` and `$feature_flag_response`;
bootstrapping alone does not emit it.

Once a flag value is known, posthog-js also stamps `$feature/landing-go` onto **every**
subsequent event automatically. Because bootstrap makes it known at init time, and
`getFeatureFlag()` runs synchronously while the init `$pageview` fires on a deferred macrotask,
exposure precedes that pageview — the correct order for PostHog experiment analysis.

`distinctID` is deliberately bootstrapped only when posthog-js has no stored identity of its
own (checked via its persistence cookie). `functions/go.js` prefers whatever id posthog-js
already holds, so for a returning identified visitor that id is their **email address**.
Passing it into `bootstrap.distinctID` unconditionally would drive posthog-js's anonymous
branch, resetting `$user_state` to `"anonymous"` and overwriting `$device_id` with that email,
cross-subdomain — silently de-identifying paying customers. See corrected §9.

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
10. ~~After the §9 fix, `$pageview` on `/`, `/2/`, and `/go` carries `funnel_variant`.~~
    Superseded — see corrected §9. No pageview-ordering fix was needed or shipped.

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

## §9 — corrected 2026-08-07: no `funnel_variant` tagging race, and a real identity bug found instead

**This section originally proposed, and Task 5 shipped, `capture_pageview: false` in `init()`
followed by `register()` then a manual `posthog.capture("$pageview")`, to fix a supposed
init/register ordering race. That fix has been reverted. The race did not exist.**

What actually happened: `funnel_variant` first shipped on 2026-07-31. The ~60% "untagged"
figure quoted in the Problem section aggregated pageviews from both before and after that date
— events before 2026-07-31 lack `funnel_variant` because the property did not exist yet, full
stop. SQL confirms: 0% tagged before 2026-08-01, ~99% tagged from 2026-08-01 onward, residual
gap decaying 63 → 10 → 8 → 1 as stale cached copies of the pre-fix script expired from browsers
and CDN edges. Independently, 100% of the untagged events carry `surface` — the sibling
property set by the exact same `register()` call — which an ordering race would also have
dropped. posthog-js has deferred its `init()` pageview by a macrotask (`setTimeout(…, 1)`)
since roughly version 1.130; `register()` runs synchronously and always completes first. There
was never a race.

The reverted fix was also not behaviour-neutral: a bare `posthog.capture("$pageview")` loses
posthog-js's built-in `visibilityState` gating, so prerendered and background-tab loads across
all nine pages of the site would have started emitting `$pageview`, inflating that metric with a
step change dated to this deploy — a regression the original fix would have introduced while
"fixing" a bug that didn't exist.

`capture_pageview: true` is restored, unchanged from before this task. No pageview-ordering
change shipped.

**A related but real bug was found and fixed while reviewing this:** `bootstrap.distinctID` was
being set unconditionally whenever the edge (`functions/go.js`) supplied a `distinctId`. In
posthog-js, passing `distinctID` into `bootstrap` drives its anonymous-identity branch — it sets
`$user_state` to `"anonymous"` and calls `register({ distinct_id, $device_id })`, overwriting
`$device_id` with whatever id was passed. `functions/go.js` deliberately prefers the id
posthog-js already holds in its own cookie, and for an already-identified visitor that id is
their **email address**. So a returning, identified customer landing on `/go` would be flipped
to anonymous, with their email permanently overwriting `$device_id` — and because both keys are
cookie-mirrored with `cross_subdomain_cookie` defaulting true, written to `.stuffsosweet.com`
and carried to `app.stuffsosweet.com`. With `person_profiles: "identified_only"`, that
visitor's subsequent events then stop updating their person profile. Measured exposure: 259
distinct email-keyed identities produced 1,876 events on the marketing site in the trailing 30
days — the paying users, and precisely who Meta retargeting sends to `/go`.

Fix shipped: `featureFlags` is always bootstrapped (that's what makes the client agree with the
page it renders, and it touches no identity); `distinctID` is bootstrapped only when posthog-js
has no stored identity of its own, checked via presence of its `ph_<key>_posthog` cookie. See
the corrected code block above.

## Files touched

| File | Change |
|---|---|
| `functions/go.js` | New — the Pages Function |
| `_redirects` | New — `/go/` → `/go` |
| `assets/posthog.js` | Bootstrap (flags always, distinctID only when no existing identity), exposure call, `arm` validation — no pageview-ordering change (see corrected §9) |
| `cf-build.sh` | Add `functions` to the prune list |
| `deploy-cf.sh` | Adjust after preview-deploy verification |
| PostHog project 207201 | New `landing-go` flag + Experiment |

`index.html` and `2/index.html` are **not** modified.
