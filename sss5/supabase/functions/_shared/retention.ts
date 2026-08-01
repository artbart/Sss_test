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

// Exported (only) so retention_test.ts can assert REASONS stays derived from
// this table without hand-maintaining a second copy of the same keys — that
// second copy is exactly the drift this module must not reintroduce. Tasks 5
// and 8 should keep using REASONS, not this.
export const LADDERS: Record<CancelReason, Rung[]> = {
  too_expensive: ["discount", "lifetime"],
  not_using:     ["pause", "downgrade"],
  ran_out:       ["pause"],
  broken:        ["support"],
};

// Derived from LADDERS (not hand-maintained) so the two can never drift: a
// fifth CancelReason forces a LADDERS entry (Record is exhaustively checked),
// and REASONS picks it up automatically. Object.keys is a safe ordering
// source here because every CancelReason value is a non-numeric string —
// the spec guarantees those string keys enumerate in insertion order, so
// REASONS keeps matching LADDERS' declaration order, which Task 8 relies on
// for rendering the reason buttons in a stable order.
export const REASONS: readonly CancelReason[] = Object.keys(LADDERS) as CancelReason[];

// The next rung to show, given what the user has already declined.
// Returns "cancel" when the ladder is exhausted.
export function nextRung(reason: CancelReason, declined: Rung[]): Rung {
  const ladder = LADDERS[reason];
  if (!ladder) return "cancel";
  return ladder.find((r) => !declined.includes(r)) ?? "cancel";
}
