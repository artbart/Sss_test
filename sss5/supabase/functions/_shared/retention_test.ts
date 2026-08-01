import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { nextRung, REASONS } from "./retention.ts";

Deno.test("price objection leads with the discount", () => {
  assertEquals(nextRung("too_expensive", []), "discount");
});

Deno.test("price objection falls back to lifetime after declining the discount", () => {
  assertEquals(nextRung("too_expensive", ["discount"]), "lifetime");
});

Deno.test("price objection cancels after declining both rungs", () => {
  assertEquals(nextRung("too_expensive", ["discount", "lifetime"]), "cancel");
});

Deno.test("low usage leads with pause, then downgrade", () => {
  assertEquals(nextRung("not_using", []), "pause");
  assertEquals(nextRung("not_using", ["pause"]), "downgrade");
  assertEquals(nextRung("not_using", ["pause", "downgrade"]), "cancel");
});

Deno.test("ran out of content gets pause only, then cancel", () => {
  assertEquals(nextRung("ran_out", []), "pause");
  assertEquals(nextRung("ran_out", ["pause"]), "cancel");
});

Deno.test("a broken product is never offered a discount", () => {
  assertEquals(nextRung("broken", []), "support");
  assertEquals(nextRung("broken", ["support"]), "cancel");
});

Deno.test("lifetime is never offered outside the price-objection branch", () => {
  for (const reason of REASONS) {
    if (reason === "too_expensive") continue;
    const seen: string[] = [];
    let rung = nextRung(reason, []);
    while (rung !== "cancel" && seen.length < 5) { seen.push(rung); rung = nextRung(reason, seen as never); }
    assertEquals(seen.includes("lifetime"), false, `lifetime leaked into the '${reason}' branch`);
  }
});

Deno.test("no branch ever shows more than two offers", () => {
  for (const reason of REASONS) {
    const seen: string[] = [];
    let rung = nextRung(reason, []);
    while (rung !== "cancel" && seen.length < 10) { seen.push(rung); rung = nextRung(reason, seen as never); }
    assertEquals(seen.length <= 2, true, `'${reason}' offered ${seen.length} rungs`);
  }
});
