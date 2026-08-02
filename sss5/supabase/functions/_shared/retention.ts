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

// Module-private: nothing outside this file should read the branch table
// directly (REASONS and nextRung are the public surface). Frozen — both the
// outer table and each ladder array — so no importer can mutate a ladder at
// runtime (e.g. LADDERS.broken.push("lifetime")) and silently break the
// "lifetime only in too_expensive" / "max two rungs" invariants with no
// compile-time signal. nextRung reads this live on every call, so a mutation
// here would take effect immediately without the freeze.
const LADDERS: Record<CancelReason, readonly Rung[]> = Object.freeze({
  too_expensive: Object.freeze<Rung[]>(["discount", "lifetime"]),
  not_using:     Object.freeze<Rung[]>(["pause", "downgrade"]),
  ran_out:       Object.freeze<Rung[]>(["pause"]),
  broken:        Object.freeze<Rung[]>(["support"]),
});

// Derived from LADDERS (not hand-maintained) so the two can never drift: a
// fifth CancelReason forces a LADDERS entry (Record is exhaustively checked),
// and REASONS picks it up automatically. Object.keys is a safe ordering
// source here because every CancelReason value is a non-numeric string —
// the spec guarantees those string keys enumerate in insertion order, so
// REASONS keeps matching LADDERS' declaration order, which Task 8 relies on
// for rendering the reason buttons in a stable order. retention_test.ts pins
// the resulting order against an explicit literal, since a derived value
// can't be asserted against a re-derivation of itself.
export const REASONS: readonly CancelReason[] = Object.keys(LADDERS) as CancelReason[];

// The next rung to show, given what the user has already declined.
// Returns "cancel" when the ladder is exhausted.
export function nextRung(reason: CancelReason, declined: Rung[]): Rung {
  const ladder = LADDERS[reason];
  if (!ladder) return "cancel";
  return ladder.find((r) => !declined.includes(r)) ?? "cancel";
}
