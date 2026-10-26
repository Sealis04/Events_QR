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
  const view = (o: ScanOutcome, ctx = {}) => resultView(o, ctx);

  it("green ADMITTED: holder, type, entry count; 1.5 s", () => {
    expect(view({ kind: "admitted", name: "Ada", typeName: "VIP", entry: 2, of: 3 })).toMatchObject(
      {
        tone: "green",
        headline: "ADMITTED",
        holder: "Ada",
        typeName: "VIP",
        chips: ["Entry 2 of 3"],
        sound: "ok",
        dismissMs: 1500,
      },
    );
    const anon = view({ kind: "admitted", name: null, typeName: "GA", entry: null, of: null });
    expect(anon.holder).toBeUndefined();
    expect(anon.chips).toEqual([]);
    expect(view({ kind: "admitted", name: "U", typeName: "GA", entry: 4, of: null }).chips).toEqual(
      ["Entry 4"],
    );
    expect(
      view({ kind: "admitted", name: "U", typeName: "GA", entry: 1, of: 1, override: true })
        .details,
    ).toEqual(["Override by supervisor"]);
  });

  it("an exit is green too, with an Exit chip and the entries left; 1 s; double beep", () => {
    expect(view({ kind: "exited", name: "Ada", typeName: "VIP", entriesLeft: 2 })).toMatchObject({
      tone: "green",
      headline: "ADMITTED",
      holder: "Ada",
      chips: ["Exit", "Entries left: 2"],
      sound: "exit",
      dismissMs: 1000,
    });
    expect(view({ kind: "exited", name: null, typeName: "x", entriesLeft: null }).chips).toEqual([
      "Exit",
      "Unlimited re-entry",
    ]);
  });

  it("grey: no re-entry", () => {
    expect(view({ kind: "no_reentry", name: "Ada", typeName: "GA" })).toMatchObject({
      tone: "grey",
      headline: "NO RE-ENTRY",
    });
  });

  it("red used / inside: when and where, who scanned, what to do; tap Next scan to dismiss", () => {
    const first = {
      gate: "Gate B",
      at: 1_900_000_000,
      device: "abcdef12-0000-4000-8000-000000000000",
    };
    for (const kind of ["used", "inside"] as const) {
      const v = view({ kind, name: "Ada", typeName: "GA", first });
      expect(v).toMatchObject({ tone: "red", dismissMs: null, sound: "bad", holder: "Ada" });
      expect(v.details[0]).toMatch(/^Entered at \d\d:\d\d through Gate B$/);
      expect(v.instruction).toBeTruthy();
    }
    expect(view({ kind: "used", name: null, typeName: "GA", first: null }).headline).toBe(
      "ALREADY USED",
    );
    expect(view({ kind: "inside", name: null, typeName: "GA", first: null }).headline).toBe(
      "ALREADY INSIDE",
    );
  });

  it("never shows a raw device id: the label, 'this phone' or 'another phone'", () => {
    const id = "abcdef12-0000-4000-8000-000000000000";
    const used = (first: object, ctx = {}) =>
      view({ kind: "used", name: "Ada", typeName: "GA", first: first as never }, ctx).details.join(
        "|",
      );
    expect(
      used({ gate: "Gate B", at: 1_900_000_000, device: id, device_label: "Phone 2" }),
    ).toContain("Scanned by Phone 2");
    expect(used({ gate: "Gate B", at: 1_900_000_000, device: id }, { deviceId: id })).toContain(
      "this phone",
    );
    expect(used({ gate: "Gate B", at: 1_900_000_000, device: id })).toContain("another phone");
    expect(used({ gate: "Gate B", at: 1_900_000_000, device: id })).not.toContain("abcdef12");
  });

  it("red reasons carry the right gate or slot times", () => {
    const wrong = view({ kind: "wrong_gate", allowedGates: ["Gate B", "VIP door"] });
    expect(wrong.headline).toBe("WRONG GATE");
    expect(wrong.instruction).toContain("Gate B or VIP door");
    expect(view({ kind: "too_early", slotStart: 1_900_000_000 })).toMatchObject({
      headline: "NOT YET",
    });
    expect(view({ kind: "too_early", slotStart: 1_900_000_000 }).instruction).toMatch(/\d\d:\d\d/);
    expect(view({ kind: "slot_ended", slotEnd: 1_900_000_000 }).headline).toBe("TOO LATE");
    expect(view({ kind: "not_ticket" }).headline).toBe("NOT A TICKET");
    expect(view({ kind: "invalid" }).headline).toBe("FORGED");
    expect(view({ kind: "wrong_event" }).headline).toBe("WRONG EVENT");
    for (const k of ["not_ticket", "invalid", "wrong_event"] as const) {
      expect(view({ kind: k })).toMatchObject({ tone: "red", dismissMs: null });
    }
    expect(view({ kind: "cancelled", name: "Ada" })).toMatchObject({
      tone: "red",
      headline: "CANCELLED",
      holder: "Ada",
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
    expect(entry.headline).toBe("NOT IN LIST");
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
