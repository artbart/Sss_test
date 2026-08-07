// Stuff So Sweet — marketing/funnel site PostHog loader.
// Loaded as an ES module from every page's <head> (alongside Meta Pixel + GTM,
// which are left untouched). Reports into the SAME PostHog project as the app
// (app.stuffsosweet.com via sss-app/assets/lib.js) so the full funnel —
// landing → quiz → checkout → app → reading — lives in one project.
//
// The key below is a PUBLIC (publishable) PostHog key; it is meant to ship in
// client-side code. Keep it identical to POSTHOG_KEY in sss-app/assets/lib.js.
//
// Pinned deliberately. This file depends on posthog-js internals that are not
// part of its public contract — that bootstrap.featureFlags marks flags as
// loaded so getFeatureFlag() emits rather than early-returning, and that
// bootstrap.distinctID without isIdentifiedID takes the anonymous branch. A
// silent 1.x bump could zero the experiment's participant count with no test
// noticing. Bump deliberately, and re-verify the /go exposure when you do.
import posthog from "https://esm.sh/posthog-js@1.414.0";

const POSTHOG_KEY = "phc_BzHnof4mQ7dmxTetogNVJF4aEynfmgDP4uHs5LBQZrFu";
const POSTHOG_HOST = "https://eu.i.posthog.com";

const ready = POSTHOG_KEY.startsWith("phc_") && !POSTHOG_KEY.includes("REPLACE");

// Which arm of the funnel A/B test this page belongs to.
//
// Assignment is NOT done here — Meta's A/B Test splits users across the two ad
// destinations (/ and /2) and randomises at user level. This only *reports*
// which arm the visitor landed in, derived from the path:
//
//   /            /quiz/            -> v1  (V1 quiz -> quiz_sessions)
//   /2  /2/      /quiz2/           -> v2  (V2 quiz -> quiz2_sessions)
//
// Path-derived rather than stored, so it stays correct through the whole
// marketing-site journey without depending on localStorage surviving.
//
// On /go the arm is decided at the edge by functions/go.js and injected as
// window.__SSS_EXP__ before this module runs. Everywhere else it is still
// derived from the path, which stays correct for direct visits to / and /2/.
const EXP = window.__SSS_EXP__ || null;

// Validated against "v1"/"v2" rather than trusted blindly: an EXP payload
// missing arm would otherwise produce funnel_variant: undefined, which
// JSON.stringify drops entirely — silently untagging every event on /go, the
// exact failure this task exists to prevent. functions/go.js always sets arm
// today; this is hardening, not a known gap.
const FUNNEL_VARIANT =
  EXP && (EXP.arm === "v1" || EXP.arm === "v2")
    ? EXP.arm
    : /^\/(2|quiz2)(\/|$)/.test(location.pathname)
      ? "v2"
      : "v1";

// True when posthog-js already holds an identity of its own. BOTH stores must
// be checked: persistence is "localStorage+cookie" and localStorage is the
// authoritative copy — the cookie is only a partial mirror, and Safari expires
// script-written cookies on a different clock than it purges storage. Reading
// only the cookie would report "no identity" for a returning visitor who has
// one, and we would bootstrap over it.
const PH_STORE_KEY = `ph_${POSTHOG_KEY}_posthog`;

const hasPhIdentity = (() => {
  try {
    if (window.localStorage && window.localStorage.getItem(PH_STORE_KEY)) return true;
  } catch (_) {
    // localStorage can throw in private mode / when storage is blocked.
  }
  return document.cookie
    .split(";")
    .some((c) => c.trim().startsWith(`${PH_STORE_KEY}=`));
})();

if (ready) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    ui_host: "https://eu.posthog.com",
    person_profiles: "identified_only", // anonymous visitors still tracked; merged on signup
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    session_recording: {
      maskAllInputs: true, // mask every form input (email, card fields, etc.) in replays
    },
    persistence: "localStorage+cookie",
    // Adopt the edge's decision verbatim, or posthog-js would roll its own dice
    // and disagree with the page it is looking at about half the time.
    //
    // distinctID is bootstrapped ONLY when posthog-js has no identity of its
    // own. Passing one when it does drives posthog-js's anonymous branch, which
    // resets $user_state to "anonymous" and overwrites $device_id — and since
    // functions/go.js prefers the id posthog-js already holds, for an
    // identified person that id is their email. Nothing is lost by skipping it:
    // the edge read that id FROM posthog-js, so the two already agree.
    bootstrap: EXP
      ? {
          featureFlags: { [EXP.flag]: EXP.variant },
          ...(EXP.distinctId && !hasPhIdentity
            ? { distinctID: EXP.distinctId }
            : {}),
        }
      : undefined,
  });
  // Tag every event from this site, including which A/B arm it came from.
  posthog.register({ surface: "marketing", funnel_variant: FUNNEL_VARIANT });

  // PostHog counts a user as participating in the experiment only when it
  // receives $feature_flag_called. Bootstrapping alone does not emit it — so
  // without this line the test renders perfectly and records zero
  // participants. Skipped for ?force= QA traffic.
  if (EXP && EXP.exposure) posthog.getFeatureFlag(EXP.flag);

  // Mirror the quiz's funnel steps into PostHog.
  //
  // The quiz already POSTs these same steps to the submit-quiz edge function
  // via postQuizEvent(); this is the analytics half, hooked at that one call
  // site so there is no second set of instrumentation to keep in sync.
  //
  // WHY identify() matters here: until the visitor types an email they are
  // anonymous, and person_profiles is "identified_only". The purchase event is
  // captured SERVER-side by stripe-webhook keyed on email (see
  // _shared/posthog.ts). Without an identify() using that same email, the
  // landing-page visit and the payment are two unrelated distinct_ids and no
  // visit -> paid funnel can ever complete. This call is what stitches them.
  //
  // funnel_variant is set via $set_once (3rd arg), so a person keeps the arm
  // they FIRST landed in even if they later visit the other page.
  window.sssTrackFunnel = function (event, payload) {
    const p = payload || {};
    try {
      if (event === "email_capture" && p.email) {
        posthog.identify(String(p.email).trim().toLowerCase(), undefined, {
          funnel_variant: FUNNEL_VARIANT,
        });
      }
      // Deliberately NOT forwarding p.email as an event property — identify()
      // already carries it as the distinct_id; duplicating it would scatter PII
      // across every event's properties.
      posthog.capture(`funnel_${event}`, {
        funnel_variant: FUNNEL_VARIANT,
        plan: p.plan ?? null,
        funnel_version: p.funnel_version ?? null,
        landing_page: p.landing_page ?? null,
      });
    } catch (e) {
      console.warn("[sss-marketing] sssTrackFunnel failed:", e);
    }
  };

  // Named conversion events without per-page wiring: tag any element with
  //   data-ph="event_name"  (optionally data-ph-props='{"plan":"monthly"}')
  // and its click is captured as that event. Autocapture still records all
  // other clicks generically; this is just for the high-signal funnel steps.
  document.addEventListener(
    "click",
    (e) => {
      const el = e.target.closest("[data-ph]");
      if (!el) return;
      let props = {};
      try {
        if (el.dataset.phProps) props = JSON.parse(el.dataset.phProps);
      } catch (_) {}
      posthog.capture(el.dataset.ph, props);
    },
    true
  );

  window.posthog = posthog;
} else {
  console.warn("[sss-marketing] PostHog key not set — analytics disabled. Paste the project key into assets/posthog.js.");
}

export { posthog };
