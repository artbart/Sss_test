// Cancellation save-flow branch table. Pure — no Stripe, no DB — so the
// flow's shape is unit-testable and both the edge function and the frontend
// agree on which rung comes next.
//
// Two invariants, enforced by retention_test.ts:
//   1. "lifetime" appears ONLY in the too_expensive branch. It permanently
//      ends recurring revenue, so it is gated behind a stated price objection.
//   2. No branch shows more than two offers. More reads as bargaining and
//      trains users to always click cancel.

export type CancelReason = "too_expensive" | "not_using" | "ran_out" | "broken";
export type Rung = "discount" | "lifetime" | "pause" | "downgrade" | "support" | "cancel";

export const REASONS: readonly CancelReason[] = ["too_expensive", "not_using", "ran_out", "broken"] as const;

const LADDERS: Record<CancelReason, Rung[]> = {
  too_expensive: ["discount", "lifetime"],
  not_using:     ["pause", "downgrade"],
  ran_out:       ["pause"],
  broken:        ["support"],
};

// The next rung to show, given what the user has already declined.
// Returns "cancel" when the ladder is exhausted.
export function nextRung(reason: CancelReason, declined: Rung[]): Rung {
  const ladder = LADDERS[reason];
  if (!ladder) return "cancel";
  return ladder.find((r) => !declined.includes(r)) ?? "cancel";
}
