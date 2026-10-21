import { isGateAllowed, maskToGates } from "./gates";
import { SLOT_NONE, slotMinuteToUnix } from "./slots";

/** The signed QR fields that gate and slot checks need. A subset of `TicketPayload`. */
export interface EntryFields {
  gateMask: number;
  slotStart: number;
  slotEnd: number;
}

export interface EntryContext {
  /** The scanning device's gate: its index in the event's gate list. */
  gateIndex: number | undefined;
  /** Now, Unix seconds UTC. */
  now: number;
  /** Unix seconds of 00:00 local on the event's first day. */
  dayZeroUnix: number;
  /** Ticket type's early-entry allowance, 15-30 minutes. */
  earlyEntryMin: number;
}

export type EntryCheck =
  | { ok: true }
  | { ok: false; reason: "wrong_gate"; allowedGates: number[] }
  | { ok: false; reason: "too_early"; slotStart: number }
  | { ok: false; reason: "slot_ended"; slotEnd: number };

/** Gate and time-slot checks from the signed fields, so they work with no ticket list. */
export function checkEntry(fields: EntryFields, ctx: EntryContext): EntryCheck {
  if (!isGateAllowed(fields.gateMask, ctx.gateIndex)) {
    return { ok: false, reason: "wrong_gate", allowedGates: maskToGates(fields.gateMask) };
  }
  if (fields.slotStart !== SLOT_NONE) {
    const start = slotMinuteToUnix(fields.slotStart, ctx.dayZeroUnix);
    if (ctx.now < start - ctx.earlyEntryMin * 60)
      return { ok: false, reason: "too_early", slotStart: start };
  }
  if (fields.slotEnd !== SLOT_NONE) {
    const end = slotMinuteToUnix(fields.slotEnd, ctx.dayZeroUnix);
    if (ctx.now > end) return { ok: false, reason: "slot_ended", slotEnd: end };
  }
  return { ok: true };
}
