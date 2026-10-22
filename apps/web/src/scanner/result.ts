import type { ScanOutcome } from "./pipeline";
import type { SyncTicket } from "./types";

export type Tone = "green" | "blue" | "grey" | "red" | "amber" | "orange";

export interface ResultView {
  tone: Tone;
  title: string;
  lines: string[];
  sound: "ok" | "exit" | "bad";
  /** Auto-dismiss after this many ms; null = tap to dismiss. */
  dismissMs: number | null;
  /** The amber screen offers a supervisor override. */
  override?: { ticketId: string; typeName: string; stub: SyncTicket };
  /** Orange banner across the top: the phone decided alone, with no hub and no VM. */
  banner?: string;
}

export const OFFLINE_BANNER = "OFFLINE";

const time = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** The result table of docs/spec.md "Result screen", as data. */
export function resultView(outcome: ScanOutcome): ResultView {
  switch (outcome.kind) {
    case "admitted": {
      const lines = [outcome.typeName];
      if (outcome.entry !== null) {
        lines.push(
          outcome.of !== null
            ? `Entry ${outcome.entry} of ${outcome.of}`
            : `Entry ${outcome.entry}`,
        );
      }
      if (outcome.override) lines.push("Override by supervisor");
      return {
        tone: "green",
        title: outcome.name ?? "Admitted",
        lines,
        sound: "ok",
        dismissMs: 1500,
        ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
      };
    }
    case "exited":
      return {
        tone: "blue",
        title: "Exit recorded",
        lines: [
          ...(outcome.name ? [outcome.name] : []),
          outcome.entriesLeft === null
            ? "Unlimited re-entry"
            : `Entries left: ${outcome.entriesLeft}`,
        ],
        sound: "exit",
        dismissMs: 1000,
        ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
      };
    case "no_reentry":
      return {
        tone: "grey",
        title: "No re-entry on this ticket",
        lines: outcome.name ? [outcome.name] : [],
        sound: "bad",
        dismissMs: 1500,
      };
    case "used":
    case "inside": {
      const lines = [...(outcome.name ? [outcome.name] : []), outcome.typeName];
      if (outcome.first) {
        lines.push(
          `${outcome.first.gate} at ${time(outcome.first.at)}` +
            (outcome.first.device ? ` · device ${outcome.first.device.slice(0, 8)}` : ""),
        );
      }
      return {
        tone: "red",
        title: outcome.offline
          ? outcome.kind === "inside"
            ? "Already inside (offline)"
            : "No entries left (offline)"
          : outcome.kind === "inside"
            ? "Already inside"
            : "Already used",
        lines,
        sound: "bad",
        dismissMs: null,
        ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
      };
    }
    case "cancelled":
      return {
        tone: "red",
        title: "Cancelled",
        lines: outcome.name ? [outcome.name] : [],
        sound: "bad",
        dismissMs: null,
      };
    case "not_ticket":
      return {
        tone: "red",
        title: "Not an event ticket",
        lines: [],
        sound: "bad",
        dismissMs: null,
      };
    case "invalid":
      return { tone: "red", title: "Invalid / forged", lines: [], sound: "bad", dismissMs: null };
    case "wrong_event":
      return { tone: "red", title: "Wrong event", lines: [], sound: "bad", dismissMs: null };
    case "wrong_gate":
      return {
        tone: "red",
        title: `Use ${outcome.allowedGates.join(" / ")}`,
        lines: ["Wrong gate for this ticket"],
        sound: "bad",
        dismissMs: null,
      };
    case "too_early":
      return {
        tone: "red",
        title: `Too early – slot starts ${time(outcome.slotStart)}`,
        lines: [],
        sound: "bad",
        dismissMs: null,
      };
    case "slot_ended":
      return {
        tone: "red",
        title: `Slot ended at ${time(outcome.slotEnd)}`,
        lines: [],
        sound: "bad",
        dismissMs: null,
      };
    case "unknown_ticket":
      return {
        tone: "amber",
        title: "Valid signature, not in list – call supervisor",
        lines: [outcome.typeName],
        sound: "bad",
        dismissMs: null,
        ...(outcome.direction === "entry"
          ? {
              override: {
                ticketId: outcome.ticketId,
                typeName: outcome.typeName,
                stub: outcome.stub,
              },
            }
          : {}),
      };
    case "offline_restricted":
      return {
        tone: "red",
        title: "Not allowed offline here",
        lines: ["This event only admits tickets limited to this gate while offline."],
        sound: "bad",
        dismissMs: null,
        banner: OFFLINE_BANNER,
      };
    case "no_connection":
      return {
        tone: "orange",
        title: "No connection",
        lines: ["This ticket was not checked. Try again when the link is back."],
        sound: "bad",
        dismissMs: null,
      };
  }
}
