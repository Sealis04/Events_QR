import { beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  decideClaim,
  decideExit,
  encodeEntryRule,
  generateEventKey,
  generateSigningKeyPair,
  mintToken,
  type ClaimState,
  type EntryMode,
  type TicketPayload,
} from "@events-qr/core";
import { ApiRejected, AuthError, NetworkError, type HubClient } from "../src/scanner/client";
import { MemoryStore } from "../src/scanner/memoryStore";
import { overrideAdmit, processScan, type PipelineDeps } from "../src/scanner/pipeline";
import type { DeviceRecord, SyncTicket } from "../src/scanner/types";

const EVENT_ID = 77;
const DAY_ZERO = 1_900_000_000;
const NOW = DAY_ZERO + 12 * 3600; // 12:00 local on day one
const GATES = ["Gate A", "Gate B", "VIP door"];
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

let eventKey: Uint8Array;
let pair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
let otherPair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
let n = 0;

interface Made {
  id: string;
  token: string;
  ticket: SyncTicket;
}

async function make(
  opts: {
    mode?: EntryMode;
    max?: number;
    type?: number;
    gateMask?: number;
    slot?: [number, number];
    name?: string | null;
    status?: SyncTicket["status"];
    signWith?: typeof pair;
    key?: Uint8Array;
    eventId?: number;
    keyId?: number;
  } = {},
): Promise<Made> {
  const id = new Uint8Array(16).fill(++n);
  const payload: TicketPayload = {
    version: 1,
    eventId: opts.eventId ?? EVENT_ID,
    ticketId: id,
    ticketType: opts.type ?? 0,
    issuedAt: DAY_ZERO,
    keyId: opts.keyId ?? 1,
    entryRule: encodeEntryRule(opts.mode ?? "single", opts.max),
    gateMask: opts.gateMask ?? 0,
    slotStart: opts.slot?.[0] ?? 0xffff,
    slotEnd: opts.slot?.[1] ?? 0xffff,
  };
  const token = await mintToken(payload, (opts.signWith ?? pair).privateKey, opts.key ?? eventKey);
  const ticket: SyncTicket = {
    id: bytesToHex(id),
    event_id: EVENT_ID,
    ticket_type: payload.ticketType,
    holder_name: opts.name === undefined ? `Holder ${n}` : opts.name,
    entry_mode: opts.mode ?? "single",
    max_admits: opts.mode === "limited" ? (opts.max ?? null) : opts.mode === "unlimited" ? null : 1,
    gate_mask: payload.gateMask,
    slot_start: null,
    slot_end: null,
    admits_used: 0,
    inside: false,
    status: opts.status ?? "valid",
    updated_at: 1,
  };
  return { id: ticket.id, token, ticket };
}

/** A tiny authority, standing in for the server, built on the same pure core rules. */
class FakeHub implements HubClient {
  states = new Map<string, ClaimState & { first?: { gate: string; at: number; device: string } }>();
  calls: { kind: string; body: unknown }[] = [];
  down: Error | undefined;
  add(t: SyncTicket) {
    this.states.set(t.id, {
      status: t.status,
      admitsUsed: t.admits_used,
      inside: t.inside,
      entryMode: t.entry_mode,
      maxAdmits: t.max_admits,
    });
  }
  async claim(body: Parameters<HubClient["claim"]>[0]) {
    this.calls.push({ kind: "claim", body });
    if (this.down) throw this.down;
    const s = this.states.get(body.ticket_id) ?? {
      status: "valid" as const,
      admitsUsed: 0,
      inside: false,
      entryMode: "single" as const,
      maxAdmits: 1,
    };
    const d = decideClaim(s);
    if (d.result === "admitted") {
      this.states.set(body.ticket_id, {
        ...d.next,
        first: { gate: body.gate, at: body.scanned_at, device: body.device_id },
      });
      return { result: "admitted" as const, admits_used: d.admitsUsed, limit: d.limit };
    }
    if (d.result === "rejected_cancelled") return { result: "rejected_cancelled" as const };
    return { result: d.result, first_scan: s.first };
  }
  async exit(body: Parameters<HubClient["exit"]>[0]) {
    this.calls.push({ kind: "exit", body });
    if (this.down) throw this.down;
    const s = this.states.get(body.ticket_id)!;
    const d = decideExit(s);
    if (d.result === "exited") {
      this.states.set(body.ticket_id, { ...s, ...d.next });
      return { result: "exited" as const, entries_left: d.entriesLeft };
    }
    return { result: d.result };
  }
  async sync(): Promise<never> {
    throw new Error("unused");
  }
  async uploadScans(): Promise<never> {
    throw new Error("unused");
  }
  async health() {}
}

let hub: FakeHub;
let store: MemoryStore;
let device: DeviceRecord;
let deps: PipelineDeps;
let clock: number;

async function setup(gate = "Gate A", direction: DeviceRecord["direction"] = "entry") {
  hub = new FakeHub();
  store = new MemoryStore();
  clock = NOW;
  device = {
    deviceId: "11111111-1111-4111-8111-111111111111",
    token: "t",
    serverUrl: "",
    gate,
    direction,
    label: null,
    clockOffset: 0,
    cursor: null,
    synced: true,
    ticketTypes: [
      { idx: 0, name: "GA", early_entry_min: 15 },
      { idx: 1, name: "Early bird", early_entry_min: 30 },
    ],
    bundle: {
      event_id: EVENT_ID,
      event_key: b64(eventKey),
      public_keys: { "1": b64(pair.publicKey) },
      gates: GATES,
      starts_at: DAY_ZERO,
      ends_at: DAY_ZERO + 86400,
      day_zero: DAY_ZERO,
      ticket_types: [],
    },
  };
  deps = {
    store,
    client: hub,
    device,
    staff: { id: "22222222-2222-4222-8222-222222222222", name: "Sam", role: "staff" },
    now: () => clock,
    newId: () => crypto.randomUUID(),
  };
}
async function known(m: Made) {
  await store.putTickets([m.ticket]);
  hub.add(m.ticket);
  return m;
}

beforeAll(async () => {
  eventKey = generateEventKey();
  pair = await generateSigningKeyPair();
  otherPair = await generateSigningKeyPair();
});

describe("scanner validation pipeline: every result state", () => {
  it("not an event ticket (plain text, setup code, URL)", async () => {
    await setup();
    for (const raw of ["hello", "DEV1:ABC", "https://example.org", ""])
      expect(await processScan(deps, raw, "entry")).toEqual({ kind: "not_ticket" });
    expect(hub.calls).toHaveLength(0);
  });

  it("red: invalid / forged for tampered, wrong-key and unknown-key codes", async () => {
    await setup();
    const good = await make();
    const tampered = good.token.slice(0, -3) + (good.token.endsWith("AAA") ? "BBB" : "AAA");
    expect(await processScan(deps, tampered, "entry")).toEqual({ kind: "invalid" });
    expect(await processScan(deps, "EVT1:NOT BASE45!", "entry")).toEqual({ kind: "invalid" });
    const forged = await make({ signWith: otherPair });
    expect(await processScan(deps, forged.token, "entry")).toEqual({ kind: "invalid" });
    const otherKey = await make({ key: generateEventKey() });
    expect(await processScan(deps, otherKey.token, "entry")).toEqual({ kind: "invalid" });
    const unknownKey = await make({ keyId: 9 });
    expect(await processScan(deps, unknownKey.token, "entry")).toEqual({ kind: "invalid" });
    expect(hub.calls).toHaveLength(0);
  });

  it("red: wrong event", async () => {
    await setup();
    const other = await make({ eventId: EVENT_ID + 1 });
    expect(await processScan(deps, other.token, "entry")).toEqual({ kind: "wrong_event" });
  });

  it("amber: valid signature, not in the list; entry checks still apply first", async () => {
    await setup();
    const fresh = await make();
    expect(await processScan(deps, fresh.token, "entry")).toMatchObject({
      kind: "unknown_ticket",
      ticketId: fresh.id,
      typeName: "GA",
      direction: "entry",
    });
    expect((await processScan(deps, fresh.token, "exit")).kind).toBe("unknown_ticket");
    const vip = await make({ gateMask: 0b100 });
    expect((await processScan(deps, vip.token, "entry")).kind).toBe("wrong_gate");
    expect(hub.calls).toHaveLength(0);
  });

  it("red: cancelled, on entry and exit", async () => {
    await setup("Gate A", "both");
    const t = await known(await make({ status: "cancelled", name: "Gone" }));
    expect(await processScan(deps, t.token, "entry")).toEqual({ kind: "cancelled", name: "Gone" });
    expect((await processScan(deps, t.token, "exit")).kind).toBe("cancelled");
    expect(hub.calls).toHaveLength(0);
  });

  it("red: cancelled on the server although the phone's list is stale", async () => {
    await setup();
    const t = await known(await make({ name: "Late cancel" }));
    hub.states.get(t.id)!.status = "cancelled";
    expect(await processScan(deps, t.token, "entry")).toEqual({
      kind: "cancelled",
      name: "Late cancel",
    });
    expect((await store.getTicket(t.id))!.status).toBe("cancelled");
  });

  it("green: admitted a single-entry ticket, then red when it is scanned again", async () => {
    await setup();
    const t = await known(await make({ name: "Ada" }));
    expect(await processScan(deps, t.token, "entry")).toEqual({
      kind: "admitted",
      name: "Ada",
      typeName: "GA",
      entry: null,
      of: null,
    });
    const body = hub.calls[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      ticket_id: t.id,
      device_id: device.deviceId,
      gate: "Gate A",
      scanned_at: NOW,
      staff_id: deps.staff!.id,
    });
    clock += 30;
    const again = await processScan(deps, t.token, "entry");
    expect(again).toMatchObject({ kind: "used", name: "Ada" });
    expect((again as { first: unknown }).first).toEqual({
      gate: "Gate A",
      at: NOW,
      device: device.deviceId,
    });
    expect(await store.getTicket(t.id)).toMatchObject({ inside: true, admits_used: 1 });
  });

  it("green with 'Entry 2 of 3' for a limited ticket; red 'used' once spent", async () => {
    await setup("Gate A", "both");
    const t = await known(await make({ mode: "limited", max: 3, name: "Lee" }));
    const entry = async () => processScan(deps, t.token, "entry");
    expect(await entry()).toMatchObject({ kind: "admitted", entry: 1, of: 3 });
    expect((await processScan(deps, t.token, "exit")).kind).toBe("exited");
    expect(await entry()).toMatchObject({ kind: "admitted", entry: 2, of: 3 });
    await processScan(deps, t.token, "exit");
    expect(await entry()).toMatchObject({ kind: "admitted", entry: 3, of: 3 });
    expect((await store.getTicket(t.id))!.status).toBe("used_up");
    await processScan(deps, t.token, "exit");
    expect(await entry()).toMatchObject({ kind: "used", name: "Lee" });
  });

  it("green 'Entry n' for an unlimited ticket", async () => {
    await setup("Gate A", "both");
    const t = await known(await make({ mode: "unlimited" }));
    expect(await processScan(deps, t.token, "entry")).toMatchObject({ entry: 1, of: null });
    await processScan(deps, t.token, "exit");
    expect(await processScan(deps, t.token, "entry")).toMatchObject({ entry: 2, of: null });
  });

  it("blue: exit recorded with the entries left; red still-inside on re-entry without exit", async () => {
    await setup("Gate A", "both");
    const t = await known(await make({ mode: "limited", max: 3, name: "Kim" }));
    await processScan(deps, t.token, "entry");
    expect(await processScan(deps, t.token, "entry")).toMatchObject({ kind: "inside" });
    expect(await processScan(deps, t.token, "exit")).toEqual({
      kind: "exited",
      name: "Kim",
      typeName: "GA",
      entriesLeft: 2,
    });
    expect(await store.getTicket(t.id)).toMatchObject({ inside: false });
  });

  it("grey: no re-entry on a single-entry ticket (exit is logged, nothing changes)", async () => {
    await setup("Gate A", "both");
    const t = await known(await make({ name: "Single" }));
    await processScan(deps, t.token, "entry");
    expect(await processScan(deps, t.token, "exit")).toEqual({
      kind: "no_reentry",
      name: "Single",
      typeName: "GA",
    });
    expect(hub.calls.map((c) => c.kind)).toEqual(["claim", "exit"]);
    expect(await store.getTicket(t.id)).toMatchObject({ inside: true });
  });

  it("red: wrong gate names the right gate(s)", async () => {
    await setup("Gate A");
    const t = await known(await make({ gateMask: 0b110 }));
    expect(await processScan(deps, t.token, "entry")).toEqual({
      kind: "wrong_gate",
      allowedGates: ["Gate B", "VIP door"],
    });
    expect(hub.calls).toHaveLength(0);
    device.gate = "Gate B";
    expect((await processScan(deps, t.token, "entry")).kind).toBe("admitted");
  });

  it("red: slot times, with the type's early-entry minutes", async () => {
    await setup();
    const startMin = 13 * 60; // 13:00
    const endMin = 15 * 60;
    const gaSlot = await known(await make({ slot: [startMin, endMin] }));
    const earlyBird = await known(await make({ type: 1, slot: [startMin, endMin] }));
    const start = DAY_ZERO + startMin * 60;

    clock = start - 14 * 60; // 14 min before: inside GA's 15 min allowance
    expect((await processScan(deps, gaSlot.token, "entry")).kind).toBe("admitted");
    clock = start - 16 * 60;
    expect(await processScan(deps, earlyBird.token, "entry")).toMatchObject({ kind: "admitted" });
    const late = await known(await make({ slot: [startMin, endMin] }));
    expect(await processScan(deps, late.token, "entry")).toEqual({
      kind: "too_early",
      slotStart: start,
    });
    const late30 = await known(await make({ slot: [startMin, endMin] }));
    clock = start - 31 * 60;
    device.ticketTypes[0]!.early_entry_min = 30;
    expect((await processScan(deps, late30.token, "entry")).kind).toBe("too_early");
    clock = start - 29 * 60;
    expect((await processScan(deps, late30.token, "entry")).kind).toBe("admitted");

    const over = await known(await make({ slot: [startMin, endMin] }));
    clock = DAY_ZERO + endMin * 60 + 1;
    expect(await processScan(deps, over.token, "entry")).toEqual({
      kind: "slot_ended",
      slotEnd: DAY_ZERO + endMin * 60,
    });
    clock = DAY_ZERO + endMin * 60;
    expect((await processScan(deps, over.token, "entry")).kind).toBe("admitted");
  });

  it("a revoked device (401) surfaces to the app instead of showing a result", async () => {
    await setup();
    const t = await known(await make());
    hub.down = new AuthError("revoked");
    await expect(processScan(deps, t.token, "entry")).rejects.toBeInstanceOf(AuthError);
  });

  it("supervisor override admits an unlisted ticket and records the supervisor", async () => {
    await setup();
    const fresh = await make();
    const sup = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Pat",
      role: "supervisor" as const,
    };
    const out = await overrideAdmit(deps, fresh.id, "GA", sup);
    expect(out).toMatchObject({ kind: "admitted", override: true, typeName: "GA" });
    expect(hub.calls[0]!.body).toMatchObject({
      override: true,
      staff_id: sup.id,
      ticket_id: fresh.id,
    });
    expect(await overrideAdmit(deps, fresh.id, "GA", sup)).toMatchObject({ kind: "used" });
    hub.down = new NetworkError("x");
    expect((await overrideAdmit(deps, fresh.id, "GA", sup)).kind).toBe("no_connection");
  });

  it("unexpected API rejections are not turned into a result", async () => {
    await setup();
    const t = await known(await make());
    hub.down = new ApiRejected(403, "wrong_direction", "nope");
    await expect(processScan(deps, t.token, "entry")).rejects.toBeInstanceOf(ApiRejected);
  });
});

describe("frame-to-result budget", () => {
  it("decode + verify + local checks take a few milliseconds (the 300 ms budget is for the phone)", async () => {
    await setup();
    const t = await known(await make());
    const stubbed: HubClient = {
      claim: async () => ({ result: "rejected_inside" }),
      exit: hub.exit.bind(hub),
      sync: hub.sync.bind(hub),
      uploadScans: hub.uploadScans.bind(hub),
      health: hub.health.bind(hub),
    };
    const runs = 50;
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await processScan({ ...deps, client: stubbed }, t.token, "entry");
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(runs / 2)]!;
    console.info(
      `pipeline (verify + checks, stubbed network) median ${median.toFixed(2)} ms, p95 ${times[Math.floor(runs * 0.95)]!.toFixed(2)} ms`,
    );
    expect(median).toBeLessThan(50);
  });
});
