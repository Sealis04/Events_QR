/**
 * One table of entry / exit / re-entry scenarios, run against both backends that decide "used":
 * the VM (MariaDB) and the venue hub (SQLite). Answers and ticket state must be identical.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { POST as claim } from "../src/app/api/claim/route";
import { POST as exit } from "../src/app/api/exit/route";
import { call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubDevice, type HubWorld } from "./hub-helpers";

type Json = Record<string, unknown>;
interface TicketRowView {
  admitsUsed: number;
  inside: boolean;
  status: string;
}

interface Backend {
  ticket(type: number): Promise<string>;
  cancel(ticketId: string): Promise<void>;
  device(gate: string, direction: string): Promise<HubDevice>;
  claim(device: HubDevice, ticketId: string, extra?: Json): Promise<{ status: number; json: Json }>;
  exit(device: HubDevice, ticketId: string, extra?: Json): Promise<{ status: number; json: Json }>;
  row(ticketId: string): Promise<TicketRowView>;
  scanCount(ticketId: string): Promise<number>;
}

let vmEnv: TestEnv;
let world: HubWorld;
let vmWorld: HubWorld; // the same world: its VM-side helpers make tickets and devices for the VM backend

const body = (device: HubDevice, ticketId: string, staffId: string, extra: Json = {}) => ({
  scan_id: randomUUID(),
  ticket_id: ticketId,
  device_id: device.id,
  staff_id: staffId,
  gate: "Gate A",
  scanned_at: vmEnv.clock.now,
  ...extra,
});

function vmBackend(): Backend {
  return {
    ticket: async (type) => (await vmWorld.makeTicket(type)).id,
    cancel: (id) => vmWorld.cancel(id),
    device: (gate, dir) => vmWorld.enrolAtVm(gate, dir),
    claim: (d, t, extra) =>
      call(claim, { bearer: d.token, body: body(d, t, vmWorld.staff.id, extra) }),
    exit: (d, t, extra) =>
      call(exit, { bearer: d.token, body: body(d, t, vmWorld.staff.id, extra) }),
    row: async (id) => {
      const [r] = await vmEnv.handle.db
        .select()
        .from(mysqlSchema.tickets)
        .where(eq(mysqlSchema.tickets.id, Buffer.from(hexToBytes(id))));
      return { admitsUsed: r!.admitsUsed, inside: r!.inside, status: r!.status };
    },
    scanCount: async (id) =>
      (
        await vmEnv.handle.db
          .select()
          .from(mysqlSchema.scans)
          .where(eq(mysqlSchema.scans.ticketId, Buffer.from(hexToBytes(id))))
      ).length,
  };
}

function hubBackend(): Backend {
  return {
    ticket: async (type) => {
      const t = await world.makeTicket(type);
      await world.pull();
      return t.id;
    },
    cancel: async (id) => {
      await world.cancel(id);
      await world.pull();
    },
    device: (gate, dir) => world.enrolAtHub(gate, dir),
    claim: (d, t, extra) => world.hubClaim(d, body(d, t, world.staff.id, extra)),
    exit: (d, t, extra) => world.hubExit(d, body(d, t, world.staff.id, extra)),
    row: async (id) => {
      const r = world.hub.db
        .select()
        .from(sqliteSchema.tickets)
        .where(eq(sqliteSchema.tickets.id, hexToBytes(id)))
        .get();
      return { admitsUsed: r!.admitsUsed, inside: r!.inside, status: r!.status };
    },
    scanCount: async (id) =>
      world.hub.db
        .select()
        .from(sqliteSchema.scans)
        .where(eq(sqliteSchema.scans.ticketId, hexToBytes(id)))
        .all().length,
  };
}

describe.skipIf(!dbAvailable)("entry and exit rules: VM and hub give the same answers", () => {
  beforeAll(async () => {
    vmEnv = await createTestEnv();
    vmWorld = await createHubWorld(vmEnv);
    world = vmWorld;
  });
  afterAll(async () => {
    await vmWorld.close();
    await vmEnv.close();
  });

  describe.each([
    ["VM (MariaDB)", vmBackend],
    ["hub (SQLite)", hubBackend],
  ])("%s", (_name, make) => {
    let b: Backend;
    let gateA: HubDevice;
    let both: HubDevice;
    let exitOnly: HubDevice;
    beforeAll(async () => {
      b = make();
      gateA = await b.device("Gate A", "entry");
      both = await b.device("Gate B", "both");
      exitOnly = await b.device("Gate B", "exit");
    });

    it("needs a matching device_id; direction is enforced; unknown ticket is 404", async () => {
      const t = await b.ticket(0);
      expect((await b.claim(gateA, t, { device_id: randomUUID() })).status).toBe(403);
      expect((await b.claim(exitOnly, t)).json).toMatchObject({
        error: { code: "wrong_direction" },
      });
      expect((await b.exit(gateA, t)).json).toMatchObject({ error: { code: "wrong_direction" } });
      expect((await b.claim(gateA, t, { staff_id: randomUUID() })).status).toBe(400);
      expect((await b.claim(gateA, "00".repeat(16))).status).toBe(404);
    });

    it("admits a single-entry ticket once; the second scan shows where it was used", async () => {
      const t = await b.ticket(0);
      const first = body(gateA, t, vmWorld.staff.id);
      const a = await call(make === vmBackend ? claim : (await import("../src/hub/routes")).claim, {
        bearer: gateA.token,
        body: first,
      });
      expect(a.status).toBe(200);
      expect(() => api.claimResponse.parse(a.json)).not.toThrow();
      expect(a.json).toMatchObject({ result: "admitted", admits_used: 1, limit: 1 });
      expect(await b.row(t)).toMatchObject({ admitsUsed: 1, inside: true, status: "used_up" });
      const second = await b.claim(gateA, t, { scanned_at: vmEnv.clock.now + 60 });
      expect(second.json.result).toBe("rejected_inside");
      expect(second.json.first_scan).toEqual({
        gate: "Gate A",
        at: first.scanned_at,
        device: gateA.id,
      });
      expect(await b.scanCount(t)).toBe(2);
    });

    it("a single-entry ticket that exits stays used (grey), and re-entry is refused", async () => {
      const t = await b.ticket(0);
      await b.claim(both, t);
      const out = await b.exit(both, t);
      expect(out.json).toEqual({ result: "no_reentry" });
      expect(await b.row(t)).toMatchObject({ inside: true });
      expect((await b.claim(both, t)).json.result).toBe("rejected_inside");
    });

    it("limited tickets need an exit before each re-entry and run out after N admits", async () => {
      const t = await b.ticket(1);
      expect((await b.claim(both, t)).json).toMatchObject({
        result: "admitted",
        admits_used: 1,
        limit: 3,
      });
      expect((await b.claim(both, t)).json.result).toBe("rejected_inside");
      expect((await b.exit(both, t)).json).toEqual({ result: "exited", entries_left: 2 });
      expect((await b.claim(both, t)).json.admits_used).toBe(2);
      await b.exit(both, t);
      expect((await b.claim(both, t)).json).toMatchObject({
        result: "admitted",
        admits_used: 3,
        limit: 3,
      });
      expect(await b.row(t)).toMatchObject({ status: "used_up", inside: true });
      expect((await b.exit(both, t)).json).toEqual({ result: "exited", entries_left: 0 });
      const again = await b.claim(both, t);
      expect(again.json.result).toBe("rejected_used");
      expect(again.json.first_scan).toBeDefined();
    });

    it("unlimited tickets re-enter after each exit with no cap", async () => {
      const t = await b.ticket(2);
      for (let i = 1; i <= 6; i++) {
        expect((await b.claim(both, t)).json).toMatchObject({
          result: "admitted",
          admits_used: i,
          limit: null,
        });
        expect((await b.exit(both, t)).json).toEqual({ result: "exited", entries_left: null });
      }
    });

    it("exiting a ticket that is not inside is logged without changing it", async () => {
      const t = await b.ticket(2);
      expect((await b.exit(both, t)).json.result).toBe("exited");
      expect(await b.row(t)).toMatchObject({ inside: false, admitsUsed: 0 });
    });

    it("refuses a cancelled ticket on entry and exit, and logs it as rejected", async () => {
      const t = await b.ticket(2);
      await b.cancel(t);
      expect((await b.claim(both, t)).json).toEqual({ result: "rejected_cancelled" });
      expect((await b.exit(both, t)).json).toEqual({ result: "rejected_cancelled" });
      expect(await b.row(t)).toMatchObject({ admitsUsed: 0, inside: false, status: "cancelled" });
    });

    it("replaying a scan_id returns the same verdict and changes nothing", async () => {
      const t = await b.ticket(1);
      const extra = { scan_id: randomUUID() };
      const first = await b.claim(both, t, extra);
      const replay = await b.claim(both, t, extra);
      expect(replay.status).toBe(200);
      expect(replay.json).toEqual(first.json);
      expect(await b.row(t)).toMatchObject({ admitsUsed: 1 });
      expect(await b.scanCount(t)).toBe(1);

      const rejected = { scan_id: randomUUID() };
      expect((await b.claim(both, t, rejected)).json.result).toBe("rejected_inside");
      expect((await b.claim(both, t, rejected)).json.result).toBe("rejected_inside");

      const x = { scan_id: randomUUID() };
      const e1 = await b.exit(both, t, x);
      expect((await b.exit(both, t, x)).json).toEqual(e1.json);
      expect(await b.row(t)).toMatchObject({ inside: false });
      // The same id for another ticket is a client bug, not a replay.
      expect((await b.claim(both, await b.ticket(2), extra)).status).toBe(409);
    });

    it("20 parallel claims of one single-entry ticket admit exactly one", async () => {
      const t = await b.ticket(0);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => b.claim(i % 2 ? gateA : both, t)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const verdicts = results.map((r) => r.json.result as string);
      expect(verdicts.filter((v) => v === "admitted")).toHaveLength(1);
      expect(verdicts.filter((v) => v === "rejected_inside")).toHaveLength(19);
      expect(await b.row(t)).toMatchObject({ admitsUsed: 1, inside: true });
    });

    it("parallel replays of one scan_id admit once", async () => {
      const t = await b.ticket(1);
      const extra = { scan_id: randomUUID() };
      const results = await Promise.all(Array.from({ length: 10 }, () => b.claim(both, t, extra)));
      expect(results.every((r) => r.status === 200 && r.json.result === "admitted")).toBe(true);
      expect(await b.row(t)).toMatchObject({ admitsUsed: 1 });
    });

    it("an override needs a supervisor's staff_id, is recorded, and still obeys one-time use", async () => {
      const t = await b.ticket(0);
      const supervisorId = vmWorld.supervisor.id;
      expect((await b.claim(both, t, { override: true })).status).toBe(403); // plain staff
      expect((await b.claim(both, t, { override: true, staff_id: null })).status).toBe(400);
      expect((await b.claim(both, t, { override: true, staff_id: supervisorId })).json.result).toBe(
        "admitted",
      );
      expect((await b.claim(both, t, { override: true, staff_id: supervisorId })).json.result).toBe(
        "rejected_inside",
      );
    });
  });
});
