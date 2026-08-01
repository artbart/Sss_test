import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hasAccess, storyLimitFor, type AccessInfo } from "./access.ts";

const FUTURE = new Date(Date.now() + 7 * 864e5).toISOString();
const PAST = new Date(Date.now() - 7 * 864e5).toISOString();

function info(over: Partial<AccessInfo> = {}): AccessInfo {
  return { periodEnd: null, subStatus: null, lifetimeAt: null, planTier: "standard", ...over };
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
