import type { EntryMode } from "./entryRule";

export type TicketStatus = "valid" | "used_up" | "cancelled";

/** The per-ticket state the hub and the offline scanner both keep. */
export interface ClaimState {
  status: TicketStatus;
  admitsUsed: number;
  inside: boolean;
  entryMode: EntryMode;
  /** 1 for single, null for unlimited, N for limited. */
  maxAdmits: number | null;
}

export type ClaimDecision =
  | { result: "admitted"; admitsUsed: number; limit: number | null; next: ClaimState }
  | { result: "rejected_inside" | "rejected_used" | "rejected_cancelled"; next: ClaimState };

/**
 * Entry check-and-mark. Mirrors the hub's SQL: the update only matches `status = 'valid' AND
 * inside = 0`; otherwise the row is read back, `inside` first, then `used_up`. The offline
 * scanner also refuses when `admitsUsed` has reached the limit even if status is still `valid`.
 * Pure: returns the next state, never mutates.
 */
export function decideClaim(state: ClaimState): ClaimDecision {
  if (state.status === "cancelled") return { result: "rejected_cancelled", next: state };
  if (state.inside) return { result: "rejected_inside", next: state };
  const exhausted = state.maxAdmits !== null && state.admitsUsed >= state.maxAdmits;
  if (state.status === "used_up" || exhausted) return { result: "rejected_used", next: state };

  const admitsUsed = state.admitsUsed + 1;
  const usedUp = state.maxAdmits !== null && admitsUsed >= state.maxAdmits;
  return {
    result: "admitted",
    admitsUsed,
    limit: state.maxAdmits,
    next: { ...state, admitsUsed, inside: true, status: usedUp ? "used_up" : state.status },
  };
}

export type ExitDecision =
  | { result: "exited"; changed: boolean; entriesLeft: number | null; next: ClaimState }
  | { result: "no_reentry" | "rejected_cancelled"; next: ClaimState };

/**
 * Exit scan. Single-entry tickets log the exit but never change state (grey screen). Re-entry
 * tickets set `inside = false`; a used-up limited ticket can still exit. Exiting a ticket that is
 * not inside is recorded as `exited` with no state change (the SQL update matches no row).
 */
export function decideExit(state: ClaimState): ExitDecision {
  if (state.status === "cancelled") return { result: "rejected_cancelled", next: state };
  if (state.entryMode === "single") return { result: "no_reentry", next: state };
  const entriesLeft =
    state.maxAdmits === null ? null : Math.max(0, state.maxAdmits - state.admitsUsed);
  if (!state.inside) return { result: "exited", changed: false, entriesLeft, next: state };
  return { result: "exited", changed: true, entriesLeft, next: { ...state, inside: false } };
}
