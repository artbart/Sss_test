// Stuff So Sweet — marketing/funnel site PostHog loader.
// Loaded as an ES module from every page's <head> (alongside Meta Pixel + GTM,
// which are left untouched). Reports into the SAME PostHog project as the app
// (app.stuffsosweet.com via sss-app/assets/lib.js) so the full funnel —
// landing → quiz → checkout → app → reading — lives in one project.
//
// The key below is a PUBLIC (publishable) PostHog key; it is meant to ship in
// client-side code. Keep it identical to POSTHOG_KEY in sss-app/assets/lib.js.
import posthog from "https://esm.sh/posthog-js@1";

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
const EXP = (typeof window !== "undefined" && window.__SSS_EXP__) || null;

const FUNNEL_VARIANT = EXP
  ? EXP.arm
  : /^\/(2|quiz2)(\/|$)/.test(location.pathname)
    ? "v2"
    : "v1";

if (ready) {
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    ui_host: "https://eu.posthog.com",
    person_profiles: "identified_only", // anonymous visitors still tracked; merged on signup
    // Captured manually below instead, so register() has already run and the
    // first pageview carries funnel_variant. Previously init() fired $pageview
    // before register(), leaving ~60% of marketing events untagged.
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: true,
    session_recording: {
      maskAllInputs: true, // mask every form input (email, card fields, etc.) in replays
    },
    persistence: "localStorage+cookie",
    // Adopt the edge's decision verbatim. Without this posthog-js would roll
    // its own dice and disagree with the page it is looking at about half the
    // time. distinctID must match what the edge used, or the two are separate
    // people. Absent on QA (?force=) requests, which carry no distinctId.
    bootstrap: EXP && EXP.distinctId
      ? {
          distinctID: EXP.distinctId,
          featureFlags: { [EXP.flag]: EXP.variant },
        }
      : undefined,
  });
  // Tag every event from this site, including which A/B arm it came from.
  posthog.register({ surface: "marketing", funnel_variant: FUNNEL_VARIANT });

  // Now that the super properties are registered, the first pageview carries
  // them. (This is the fix for the untagged-events gap described above.)
  posthog.capture("$pageview");

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
