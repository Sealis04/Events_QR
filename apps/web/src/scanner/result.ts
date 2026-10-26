import type { ScanOutcome } from "./pipeline";
import type { SyncTicket } from "./types";

export type Tone = "green" | "blue" | "grey" | "red" | "amber" | "orange";
export type Icon = "check" | "exit" | "cross" | "warn";

export interface ResultView {
  tone: Tone;
  /** The big word: ADMITTED, ALREADY USED, WRONG GATE, … */
  headline: string;
  icon: Icon;
  /** Holder's name, when known. */
  holder?: string;
  /** Ticket type, when known. */
  typeName?: string;
  /** Chips next to the type on green screens ("Entry 1 of 3"). */
  chips: string[];
  /** Facts under the headline (when and where an "already used" ticket got in). */
  details: string[];
  /** One plain line of what to do. */
  instruction?: string;
  sound: "ok" | "exit" | "bad";
  /** Auto-dismiss after this many ms; null = tap "Next scan". */
  dismissMs: number | null;
  /** The amber screen offers a supervisor override. */
  override?: { ticketId: string; typeName: string; stub: SyncTicket };
  /** Orange banner across the top: the phone decided alone, with no hub and no VM. */
  banner?: string;
}

export const OFFLINE_BANNER = "OFFLINE";

/** What the result screen knows about this phone, so it can say "this phone" instead of an id. */
export interface ResultContext {
  deviceId?: string;
}

/** Event-clock-free HH:mm in the phone's own zone (the gate staff and the phone share one). */
const time = (unix: number) =>
  new Date(unix * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const red = (
  headline: string,
  instruction: string,
  extra: Partial<ResultView> = {},
): ResultView => ({
  tone: "red",
  headline,
  icon: "cross",
  chips: [],
  details: [],
  instruction,
  sound: "bad",
  dismissMs: null,
  ...extra,
});

/** Never a raw device id: the label when the server sends one, else this phone / another phone. */
function whoScanned(
  first: NonNullable<Extract<ScanOutcome, { kind: "used" | "inside" }>["first"]>,
  ctx: ResultContext,
): string {
  const label = (first as { device_label?: string | null }).device_label;
  if (label) return `Scanned by ${label}`;
  if (first.device && ctx.deviceId && first.device === ctx.deviceId) return "Scanned on this phone";
  return first.device ? "Scanned on another phone" : "";
}

/** The result table of docs/spec.md "Result screen", as data. */
export function resultView(outcome: ScanOutcome, ctx: ResultContext = {}): ResultView {
  switch (outcome.kind) {
    case "admitted": {
      const chips: string[] = [];
      if (outcome.entry !== null)
        chips.push(
          outcome.of !== null
            ? `Entry ${outcome.entry} of ${outcome.of}`
            : `Entry ${outcome.entry}`,
        );
      return {
        tone: "green",
        headline: "ADMITTED",
        icon: "check",
        ...(outcome.name ? { holder: outcome.name } : {}),
        typeName: outcome.typeName,
        chips,
        details: outcome.override ? ["Override by supervisor"] : [],
        sound: "ok",
        dismissMs: 1500,
        ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
      };
    }
    case "exited":
      return {
        tone: "green",
        headline: "ADMITTED",
        icon: "check",
        ...(outcome.name ? { holder: outcome.name } : {}),
        typeName: outcome.typeName,
        chips: [
          "Exit",
          outcome.entriesLeft === null
            ? "Unlimited re-entry"
            : `Entries left: ${outcome.entriesLeft}`,
        ],
        details: [],
        sound: "exit",
        dismissMs: 1000,
        ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
      };
    case "no_reentry":
      return {
        tone: "grey",
        headline: "NO RE-ENTRY",
        icon: "cross",
        ...(outcome.name ? { holder: outcome.name } : {}),
        typeName: outcome.typeName,
        chips: [],
        details: [],
        instruction: "This ticket cannot come back in. Tell them it is a single-entry ticket.",
        sound: "bad",
        dismissMs: 1500,
      };
    case "used":
    case "inside": {
      const details: string[] = [];
      if (outcome.first) {
        details.push(`Entered at ${time(outcome.first.at)} through ${outcome.first.gate}`);
        const who = whoScanned(outcome.first, ctx);
        if (who) details.push(who);
      }
      if (outcome.offline) details.push("Decided on this phone while offline");
      const inside = outcome.kind === "inside";
      return red(
        inside ? "ALREADY INSIDE" : outcome.offline ? "NO ENTRIES LEFT" : "ALREADY USED",
        inside
          ? "They are already inside. Do not let them in again; ask the supervisor desk if unsure."
          : "Do not let them in. Send them to the supervisor desk.",
        {
          ...(outcome.name ? { holder: outcome.name } : {}),
          typeName: outcome.typeName,
          details,
          ...(outcome.offline ? { banner: OFFLINE_BANNER } : {}),
        },
      );
    }
    case "cancelled":
      return red("CANCELLED", "This ticket was cancelled. Send them to the supervisor desk.", {
        ...(outcome.name ? { holder: outcome.name } : {}),
      });
    case "not_ticket":
      return red("NOT A TICKET", "This code is not an event ticket. Ask them for their ticket QR.");
    case "invalid":
      return red(
        "FORGED",
        "This ticket failed the security check. Do not let them in; call a supervisor.",
      );
    case "wrong_event":
      return red("WRONG EVENT", "This ticket is for a different event.");
    case "wrong_gate":
      return red("WRONG GATE", `Send them to ${outcome.allowedGates.join(" or ")}.`);
    case "too_early":
      return red("NOT YET", `Their entry time starts at ${time(outcome.slotStart)}.`);
    case "slot_ended":
      return red("TOO LATE", `Their entry time ended at ${time(outcome.slotEnd)}.`);
    case "unknown_ticket":
      return {
        tone: "amber",
        headline: "NOT IN LIST",
        icon: "warn",
        typeName: outcome.typeName,
        chips: [],
        details: [],
        instruction:
          "The ticket is genuine but this phone does not know it yet. Call a supervisor.",
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
      return red(
        "NOT ALLOWED OFFLINE",
        "With no connection this event only admits tickets limited to this gate.",
        { banner: OFFLINE_BANNER },
      );
    case "no_connection":
      return {
        tone: "orange",
        headline: "NO CONNECTION",
        icon: "warn",
        chips: [],
        details: [],
        instruction: "This ticket was not checked. Try again when the link is back.",
        sound: "bad",
        dismissMs: null,
      };
  }
}
