/** "Set up again": upload first, a supervisor PIN when scans would be lost, then a full wipe. */
import { beforeAll, describe, expect, it } from "vitest";
import { hashPin } from "../src/server/auth";
import { MemoryStore } from "../src/scanner/memoryStore";
import { NotSupervisor, setUpAgain } from "../src/scanner/reset";
import type { DeviceRecord, OutboxScan } from "../src/scanner/types";
import { createFixtures, DEVICE_ID } from "./scanner-fixtures";

let device: DeviceRecord;

beforeAll(async () => {
  const fx = await createFixtures();
  device = fx.device({
    staff: [
      { id: "s-1", name: "Sam", role: "staff", pinHash: await hashPin("246810") },
      { id: "s-2", name: "Pat", role: "supervisor", pinHash: await hashPin("135791") },
    ],
  });
});

const scan = (n: number): OutboxScan => ({
  scan_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ticket_id: `${n}`.padStart(32, "0"),
  device_id: DEVICE_ID,
  staff_id: null,
  gate: "Gate A",
  direction: "entry",
  scanned_at: 1_900_000_000 + n,
  result: "admitted",
  offline: true,
});

async function filled(n: number): Promise<MemoryStore> {
  const store = new MemoryStore();
  await store.setDevice(device);
  await store.setMeta("pin-lockout", { fails: 2, until: 0, rounds: 0 });
  for (let i = 1; i <= n; i++) await store.commitOffline(await ticketFor(i), scan(i));
  return store;
}
const ticketFor = async (n: number) => ({
  id: `${n}`.padStart(32, "0"),
  event_id: 77,
  ticket_type: 0,
  holder_name: null,
  entry_mode: "single" as const,
  max_admits: 1,
  gate_mask: 0,
  slot_start: null,
  slot_end: null,
  admits_used: 1,
  inside: true,
  status: "used_up" as const,
  updated_at: 1,
});

const down: typeof fetch = async () => {
  throw new TypeError("network down");
};
/** Both servers answer: scans are acknowledged, logins are refused as unknown. */
const up: typeof fetch = async (input, init) => {
  const url = String(input);
  if (url.endsWith("/api/scans")) {
    const { scans } = JSON.parse(String(init?.body)) as { scans: OutboxScan[] };
    return Response.json({ acknowledged: scans.map((s) => s.scan_id), conflicts: [] });
  }
  return new Response("{}", { status: 404 });
};

function expectEmpty(store: MemoryStore) {
  expect(store.device).toBeUndefined();
  expect(store.tickets.size).toBe(0);
  expect(store.outbox).toHaveLength(0);
  expect(store.meta.size).toBe(0);
}

describe("set up again", () => {
  it("wipes straight away when the outbox is empty", async () => {
    const store = await filled(0);
    await store.putTickets([await ticketFor(9)]);
    expect(await setUpAgain(store, device, { doFetch: down })).toEqual({
      kind: "wiped",
      uploaded: 0,
    });
    expectEmpty(store);
  });

  it("uploads queued scans first and then wipes without asking", async () => {
    const store = await filled(3);
    expect(await setUpAgain(store, device, { doFetch: up })).toEqual({
      kind: "wiped",
      uploaded: 3,
    });
    expectEmpty(store);
  });

  it("with scans stuck in the outbox, says how many would be lost and keeps everything", async () => {
    const store = await filled(3);
    expect(await setUpAgain(store, device, { doFetch: down })).toEqual({
      kind: "needs_supervisor",
      lost: 3,
    });
    expect(store.device).toBeDefined();
    expect(store.outbox).toHaveLength(3);
    expect(store.tickets.size).toBe(3);
  });

  it("a supervisor PIN (checked against the phone's own list when offline) lets it wipe", async () => {
    const store = await filled(2);
    const res = await setUpAgain(store, device, {
      doFetch: down,
      supervisor: { name: "Pat", pin: "135791" },
    });
    expect(res).toEqual({ kind: "wiped", uploaded: 0 });
    expectEmpty(store);
  });

  it("refuses a staff account and a wrong PIN, and wipes nothing", async () => {
    const store = await filled(2);
    await expect(
      setUpAgain(store, device, { doFetch: down, supervisor: { name: "Sam", pin: "246810" } }),
    ).rejects.toBeInstanceOf(NotSupervisor);
    await expect(
      setUpAgain(store, device, { doFetch: down, supervisor: { name: "Pat", pin: "000000" } }),
    ).rejects.toThrow(/Wrong name or PIN/);
    expect(store.device).toBeDefined();
    expect(store.outbox).toHaveLength(2);
  });
});
