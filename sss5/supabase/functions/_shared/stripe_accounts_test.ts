import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  parseAccount,
  requiresOwnershipMarker,
  envKeyFor,
  priceFor,
  planConfig,
  EXPECTED_ACCT_ID,
  STRIPE_ACCOUNTS,
} from "./stripe_accounts.ts";

Deno.test("parseAccount defaults null and undefined to leadoni", () => {
  assertEquals(parseAccount(null), "leadoni");
  assertEquals(parseAccount(undefined), "leadoni");
  assertEquals(parseAccount(""), "leadoni");
});

Deno.test("parseAccount passes through known labels", () => {
  assertEquals(parseAccount("leadoni"), "leadoni");
  assertEquals(parseAccount("astronaut"), "astronaut");
});

Deno.test("parseAccount throws on an unknown label rather than guessing", () => {
  assertThrows(() => parseAccount("stripe"), Error, "unknown stripe account");
});

Deno.test("account ids are the real ones and are distinct", () => {
  assertEquals(EXPECTED_ACCT_ID.leadoni, "acct_1TRcmOKD4axecwd4");
  assertEquals(EXPECTED_ACCT_ID.astronaut, "acct_1U287eKdnhowNC0W");
});

Deno.test("astronaut is tried first so the common case short-circuits", () => {
  assertEquals([...STRIPE_ACCOUNTS], ["astronaut", "leadoni"]);
});

Deno.test("only leadoni needs the ownership marker", () => {
  assertEquals(requiresOwnershipMarker("leadoni"), true);
  assertEquals(requiresOwnershipMarker("astronaut"), false);
});

Deno.test("leadoni env keys are unprefixed, astronaut env keys are prefixed", () => {
  assertEquals(envKeyFor("leadoni", "PRICE_1W"), "STRIPE_PRICE_1W");
  assertEquals(envKeyFor("astronaut", "PRICE_1W"), "STRIPE_ASTRONAUT_PRICE_1W");
  assertEquals(envKeyFor("leadoni", "SECRET_KEY"), "STRIPE_SECRET_KEY");
  assertEquals(envKeyFor("astronaut", "SECRET_KEY"), "STRIPE_ASTRONAUT_SECRET_KEY");
  assertEquals(envKeyFor("leadoni", "WEBHOOK_SECRET"), "STRIPE_WEBHOOK_SECRET");
  assertEquals(envKeyFor("astronaut", "WEBHOOK_SECRET"), "STRIPE_ASTRONAUT_WEBHOOK_SECRET");
});

Deno.test("priceFor reads the account-appropriate env var", () => {
  Deno.env.set("STRIPE_PRICE_1W", "price_leadoni_1w");
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_1W", "price_astronaut_1w");
  assertEquals(priceFor("leadoni", "1W"), "price_leadoni_1w");
  assertEquals(priceFor("astronaut", "1W"), "price_astronaut_1w");
});

Deno.test("priceFor returns null when unset rather than an empty string", () => {
  Deno.env.delete("STRIPE_ASTRONAUT_PRICE_TEST");
  assertEquals(priceFor("astronaut", "TEST"), null);
});

Deno.test("planConfig maps funnel plan keys to the account's price plus coupon", () => {
  Deno.env.set("STRIPE_PRICE_4W", "price_leadoni_4w");
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_4W", "price_astronaut_4w");
  Deno.env.set("STRIPE_COUPON_4W", "da8lCgTH");
  assertEquals(planConfig("leadoni", "4"), { priceId: "price_leadoni_4w", couponId: "da8lCgTH" });
  assertEquals(planConfig("astronaut", "4"), { priceId: "price_astronaut_4w", couponId: "da8lCgTH" });
});

Deno.test("planConfig plan 1 has no coupon", () => {
  Deno.env.set("STRIPE_ASTRONAUT_PRICE_1W", "price_astronaut_1w");
  assertEquals(planConfig("astronaut", "1"), { priceId: "price_astronaut_1w" });
});

Deno.test("planConfig returns null for an unknown plan key", () => {
  assertEquals(planConfig("astronaut", "99"), null);
});

Deno.test("planConfig returns null when the price env var is missing", () => {
  Deno.env.delete("STRIPE_ASTRONAUT_PRICE_8W");
  Deno.env.set("STRIPE_COUPON_8W", "rzYEbzrc");
  assertEquals(planConfig("astronaut", "8"), null);
});
