import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { LADDERS, nextRung, REASONS, type CancelReason } from "./retention.ts";

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

Deno.test("an unrecognized reason falls back to cancel instead of throwing", () => {
  assertEquals(nextRung("bogus" as CancelReason, []), "cancel");
});

Deno.test("REASONS cannot silently drift from the branch table it is derived from", () => {
  // Task 5 validates HTTP bodies against REASONS and Task 8 renders reason
  // buttons from it. If it ever stopped being derived from the same source
  // as nextRung's routing, a reason could compile fine while being
  // un-selectable in the UI and rejected by the API.
  const ladderReasons = Object.keys(LADDERS);
  assertEquals(new Set(REASONS).size, REASONS.length);
  assertEquals(new Set(ladderReasons).size, ladderReasons.length);
  assertEquals(
    [...REASONS].sort(),
    [...ladderReasons].sort(),
    "REASONS and the branch table's keys must contain exactly the same members",
  );
});
