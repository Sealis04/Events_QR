import { describe, expect, it } from "vitest";
import { resultView } from "../src/scanner/result";
import type { ScanOutcome } from "../src/scanner/pipeline";

const stub = {
  id: "ab".repeat(16),
  event_id: 1,
  ticket_type: 0,
  holder_name: null,
  entry_mode: "single" as const,
  max_admits: 1,
  gate_mask: 0,
  slot_start: null,
  slot_end: null,
  admits_used: 0,
  inside: false,
  status: "valid" as const,
  updated_at: 0,
};

describe("result screens follow the spec table", () => {
  const view = (o: ScanOutcome) => resultView(o);

  it("green admitted: name, type, entry count; 1.5 s", () => {
    expect(view({ kind: "admitted", name: "Ada", typeName: "VIP", entry: 2, of: 3 })).toMatchObject(
      { tone: "green", title: "Ada", lines: ["VIP", "Entry 2 of 3"], sound: "ok", dismissMs: 1500 },
    );
    expect(
      view({ kind: "admitted", name: null, typeName: "GA", entry: null, of: null }).lines,
    ).toEqual(["GA"]);
    expect(
      view({ kind: "admitted", name: "U", typeName: "GA", entry: 4, of: null }).lines,
    ).toContain("Entry 4");
  });

  it("blue exit: name and entries left; 1 s; double beep", () => {
    expect(view({ kind: "exited", name: "Ada", typeName: "VIP", entriesLeft: 2 })).toMatchObject({
      tone: "blue",
      title: "Exit recorded",
      lines: ["Ada", "Entries left: 2"],
      sound: "exit",
      dismissMs: 1000,
    });
    expect(view({ kind: "exited", name: null, typeName: "x", entriesLeft: null }).lines).toEqual([
      "Unlimited re-entry",
    ]);
  });

  it("grey: no re-entry", () => {
    expect(view({ kind: "no_reentry", name: "Ada", typeName: "GA" })).toMatchObject({
      tone: "grey",
      title: "No re-entry on this ticket",
    });
  });

  it("red used / inside: first scan's gate, time and device; tap to dismiss", () => {
    const first = {
      gate: "Gate B",
      at: 1_900_000_000,
      device: "abcdef12-0000-4000-8000-000000000000",
    };
    for (const kind of ["used", "inside"] as const) {
      const v = view({ kind, name: "Ada", typeName: "GA", first });
      expect(v).toMatchObject({ tone: "red", dismissMs: null, sound: "bad" });
      expect(v.lines.join(" ")).toContain("Gate B");
      expect(v.lines.join(" ")).toContain("device abcdef12");
    }
    expect(view({ kind: "used", name: null, typeName: "GA", first: null }).title).toBe(
      "Already used",
    );
    expect(view({ kind: "inside", name: null, typeName: "GA", first: null }).title).toBe(
      "Already inside",
    );
  });

  it("red reasons carry the right gate or slot times", () => {
    expect(view({ kind: "wrong_gate", allowedGates: ["Gate B", "VIP door"] }).title).toBe(
      "Use Gate B / VIP door",
    );
    expect(view({ kind: "too_early", slotStart: 1_900_000_000 }).title).toMatch(
      /^Too early – slot starts \d/,
    );
    expect(view({ kind: "slot_ended", slotEnd: 1_900_000_000 }).title).toMatch(/^Slot ended at \d/);
    for (const k of ["not_ticket", "invalid", "wrong_event"] as const) {
      expect(view({ kind: k })).toMatchObject({ tone: "red", dismissMs: null });
    }
    expect(view({ kind: "cancelled", name: "Ada" })).toMatchObject({
      tone: "red",
      title: "Cancelled",
    });
  });

  it("amber offers the supervisor override on entry only", () => {
    const entry = view({
      kind: "unknown_ticket",
      ticketId: "ab".repeat(16),
      typeName: "GA",
      direction: "entry",
      stub,
    });
    expect(entry).toMatchObject({
      tone: "amber",
      dismissMs: null,
      override: { ticketId: "ab".repeat(16) },
    });
    expect(entry.title).toBe("Valid signature, not in list – call supervisor");
    expect(
      view({
        kind: "unknown_ticket",
        ticketId: "ab".repeat(16),
        typeName: "GA",
        direction: "exit",
        stub,
      }).override,
    ).toBeUndefined();
  });

  it("orange: no connection", () => {
    expect(view({ kind: "no_connection" })).toMatchObject({ tone: "orange", dismissMs: null });
  });
});
