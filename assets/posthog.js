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
  });
  posthog.register({ surface: "marketing" }); // tag every event from this site

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
