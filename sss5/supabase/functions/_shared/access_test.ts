import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasAccess, storyLimitFor, type AccessInfo } from "./access.ts";

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const PAST = new Date(Date.now() - 7 * 864e5).toISOString();

function info(over: Partial<AccessInfo> = {}): AccessInfo {
  return { periodEnd: null, subStatus: null, lifetimeAt: null, planTier: "standard", lookupFailed: false, ...over };
}

Deno.test("paid-through user has access", () => {
  assertEquals(hasAccess(info({ periodEnd: FUTURE })), true);
});

Deno.test("expired user has no access", () => {
  assertEquals(hasAccess(info({ periodEnd: PAST })), false);
});

Deno.test("lifetime holder has access despite an expired period", () => {
  assertEquals(hasAccess(info({ periodEnd: PAST, lifetimeAt: PAST, subStatus: "canceled" })), true);
});

Deno.test("lifetime holder has access with no subscription at all", () => {
  assertEquals(hasAccess(info({ lifetimeAt: PAST })), true);
});

Deno.test("no subscription and no lifetime means no access", () => {
  assertEquals(hasAccess(info()), false);
});

Deno.test("standard tier gets 3 stories", () => {
  assertEquals(storyLimitFor("standard"), 3);
});

Deno.test("lite tier gets 1 story", () => {
  assertEquals(storyLimitFor("lite"), 1);
});

Deno.test("unknown or missing tier falls back to standard", () => {
  assertEquals(storyLimitFor(null), 3);
  assertEquals(storyLimitFor(undefined), 3);
  assertEquals(storyLimitFor("nonsense"), 3);
});

// --- lookupFailed: "could not determine access" must not read as "no access" ---

Deno.test("lookup-failed info reads as having no access (hasAccess stays a pure entitlement check)", () => {
  assertEquals(hasAccess(info({ lookupFailed: true })), false);
});

Deno.test("lookup-failed is distinguishable from a legitimate no-subscription result", () => {
  const failed = info({ lookupFailed: true });
  const noSub = info({ lookupFailed: false });
  // Both currently produce hasAccess() === false, but callers must branch on
  // lookupFailed BEFORE consulting hasAccess() — a failed lookup should
  // surface as a 5xx, never as a 403/402 entitlement denial.
  assertEquals(hasAccess(failed), false);
  assertEquals(hasAccess(noSub), false);
  assertEquals(failed.lookupFailed, true);
  assertEquals(noSub.lookupFailed, false);
});

Deno.test("hasAccess ignores lookupFailed entirely — it is not a hidden override", () => {
  // Defensive/contract test: hasAccess() must remain a pure function of
  // periodEnd/lifetimeAt. It must not special-case lookupFailed in either
  // direction (not force-deny, not force-grant) — the caller owns that
  // branch. resolveAccess never actually produces this combination (a failed
  // query always nulls out the entitlement fields too), but the predicate
  // itself must not assume that invariant.
  assertEquals(hasAccess(info({ lookupFailed: true, lifetimeAt: PAST })), true);
  assertEquals(hasAccess(info({ lookupFailed: true, periodEnd: FUTURE })), true);
});
