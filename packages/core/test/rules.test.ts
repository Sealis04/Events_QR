import { describe, expect, it } from "vitest";
import {
  checkEntry,
  decideClaim,
  decideExit,
  decodeEntryRule,
  encodeEntryRule,
  gatesToMask,
  isGateAllowed,
  maskToGates,
  slotMinuteToUnix,
  SLOT_NONE,
  unixToSlotMinute,
  type ClaimState,
} from "../src";

const state = (over: Partial<ClaimState> = {}): ClaimState => ({
  status: "valid",
  admitsUsed: 0,
  inside: false,
  entryMode: "single",
  maxAdmits: 1,
  ...over,
});

describe("entry_rule", () => {
  it("encodes mode in the top 2 bits and max admits in the low 6", () => {
    expect(encodeEntryRule("single")).toBe(0x00);
    expect(encodeEntryRule("unlimited")).toBe(0x40);
    expect(encodeEntryRule("limited", 2)).toBe(0x82);
    expect(encodeEntryRule("limited", 63)).toBe(0xbf);
  });
  it("round-trips and decodes to the max_admits column semantics", () => {
    expect(decodeEntryRule(0x00)).toEqual({ mode: "single", maxAdmits: 1 });
    expect(decodeEntryRule(0x40)).toEqual({ mode: "unlimited", maxAdmits: null });
    for (let n = 2; n <= 63; n++)
      expect(decodeEntryRule(encodeEntryRule("limited", n))).toEqual({
        mode: "limited",
        maxAdmits: n,
      });
  });
  it("rejects invalid values", () => {
    for (const n of [0, 1, 64, null, undefined, 2.5])
      expect(() => encodeEntryRule("limited", n as number)).toThrow();
    for (const b of [0x01, 0x41, 0x80, 0x81, 0xc0, 0x100, -1])
      expect(() => decodeEntryRule(b)).toThrow();
  });
});

describe("gate_mask", () => {
  it("converts gate indexes to a mask and back", () => {
    expect(gatesToMask([])).toBe(0);
    expect(gatesToMask([0, 2])).toBe(0b101);
    expect(gatesToMask([15])).toBe(0x8000);
    expect(maskToGates(0b101)).toEqual([0, 2]);
    expect(maskToGates(0xffff)).toHaveLength(16);
    expect(maskToGates(0)).toEqual([]);
  });
  it("treats 0 as any gate", () => {
    expect(isGateAllowed(0, 5)).toBe(true);
    expect(isGateAllowed(0, undefined)).toBe(true);
    expect(isGateAllowed(0b10, 1)).toBe(true);
    expect(isGateAllowed(0b10, 0)).toBe(false);
    expect(isGateAllowed(0b10, undefined)).toBe(false);
  });
  it("rejects out-of-range indexes", () => {
    expect(() => gatesToMask([16])).toThrow();
    expect(() => gatesToMask([-1])).toThrow();
    expect(() => maskToGates(0x10000)).toThrow();
  });
});

describe("slot minutes", () => {
  it("converts between Unix seconds and minutes from day zero", () => {
    const dayZero = 1_800_000_000;
    expect(unixToSlotMinute(dayZero + 17 * 3600, dayZero)).toBe(1020);
    expect(slotMinuteToUnix(1020, dayZero)).toBe(dayZero + 17 * 3600);
    expect(unixToSlotMinute(dayZero + 45 * 86400, dayZero)).toBe(64800); // 45 days fits
    expect(() => unixToSlotMinute(dayZero - 60, dayZero)).toThrow();
    expect(() => slotMinuteToUnix(SLOT_NONE, dayZero)).toThrow();
  });
});

describe("checkEntry", () => {
  const dayZero = 1_800_000_000;
  const base = { gateMask: 0, slotStart: SLOT_NONE, slotEnd: SLOT_NONE };
  const ctx = (over: object = {}) => ({
    gateIndex: 0,
    now: dayZero,
    dayZeroUnix: dayZero,
    earlyEntryMin: 15,
    ...over,
  });

  it("allows tickets with no gate or slot restrictions", () => {
    expect(checkEntry(base, ctx())).toEqual({ ok: true });
  });
  it("honours a 30-minute early-entry allowance", () => {
    const f = { ...base, slotStart: 1080 }; // 18:00
    const at = (m: number) => ctx({ now: dayZero + m * 60, earlyEntryMin: 30 });
    expect(checkEntry(f, at(1049)).ok).toBe(false);
    expect(checkEntry(f, at(1050)).ok).toBe(true);
  });
  it("applies slot_start and slot_end independently", () => {
    expect(checkEntry({ ...base, slotEnd: 10 }, ctx({ now: dayZero + 11 * 60 })).ok).toBe(false);
    expect(checkEntry({ ...base, slotEnd: 10 }, ctx({ now: dayZero + 5 * 60 })).ok).toBe(true);
    expect(checkEntry({ ...base, slotStart: 100 }, ctx({ now: dayZero + 99 * 60 + 1 })).ok).toBe(
      true,
    );
  });
  it("checks the gate before the slot", () => {
    const r = checkEntry(
      { gateMask: 0b10, slotStart: 1000, slotEnd: SLOT_NONE },
      ctx({ gateIndex: 0 }),
    );
    expect(r).toMatchObject({ ok: false, reason: "wrong_gate" });
  });
});

describe("decideClaim", () => {
  it("admits a single-entry ticket once, then rejects it", () => {
    const first = decideClaim(state());
    expect(first).toMatchObject({ result: "admitted", admitsUsed: 1, limit: 1 });
    expect(first.next).toMatchObject({ status: "used_up", inside: true, admitsUsed: 1 });
    // Same screenshot at another gate: still inside.
    expect(decideClaim(first.next).result).toBe("rejected_inside");
  });

  it("reports rejected_used once a single ticket has been used and is outside", () => {
    expect(decideClaim(state({ status: "used_up", admitsUsed: 1 })).result).toBe("rejected_used");
  });

  it("requires an exit before re-entry (unlimited)", () => {
    const u = state({ entryMode: "unlimited", maxAdmits: null });
    const in1 = decideClaim(u);
    expect(in1).toMatchObject({ result: "admitted", admitsUsed: 1, limit: null });
    expect(in1.next.status).toBe("valid");
    expect(decideClaim(in1.next).result).toBe("rejected_inside");
    const out = decideExit(in1.next);
    expect(out).toMatchObject({ result: "exited", changed: true, entriesLeft: null });
    const in2 = decideClaim(out.next);
    expect(in2).toMatchObject({ result: "admitted", admitsUsed: 2 });
  });

  it("counts entries for limited tickets and becomes used_up at N", () => {
    let s = state({ entryMode: "limited", maxAdmits: 3 });
    for (let n = 1; n <= 3; n++) {
      const d = decideClaim(s);
      expect(d).toMatchObject({ result: "admitted", admitsUsed: n, limit: 3 });
      s = d.next;
      expect(s.status).toBe(n === 3 ? "used_up" : "valid");
      const x = decideExit(s);
      expect(x).toMatchObject({ result: "exited", changed: true, entriesLeft: 3 - n }); // used-up tickets can still exit
      s = x.next;
    }
    expect(decideClaim(s).result).toBe("rejected_used");
  });

  it("refuses at the limit even if the cached status is still valid (offline)", () => {
    expect(decideClaim(state({ entryMode: "limited", maxAdmits: 2, admitsUsed: 2 })).result).toBe(
      "rejected_used",
    );
  });

  it("rejects cancelled tickets, even when inside", () => {
    expect(decideClaim(state({ status: "cancelled" })).result).toBe("rejected_cancelled");
    expect(decideClaim(state({ status: "cancelled", inside: true })).result).toBe(
      "rejected_cancelled",
    );
  });

  it("does not mutate its input", () => {
    const s = state();
    const copy = { ...s };
    decideClaim(s);
    expect(s).toEqual(copy);
  });
});

describe("decideExit", () => {
  it("logs but never changes a single-entry ticket", () => {
    const s = state({ inside: true, status: "used_up", admitsUsed: 1 });
    const d = decideExit(s);
    expect(d.result).toBe("no_reentry");
    expect(d.next).toEqual(s);
  });
  it("is a no-op change for a re-entry ticket that is not inside", () => {
    const d = decideExit(state({ entryMode: "unlimited", maxAdmits: null }));
    expect(d).toMatchObject({ result: "exited", changed: false });
  });
  it("rejects cancelled tickets", () => {
    expect(
      decideExit(state({ entryMode: "unlimited", maxAdmits: null, status: "cancelled" })).result,
    ).toBe("rejected_cancelled");
  });
});
