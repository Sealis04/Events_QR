import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, decodeSetupCode, hexToBytes, mysqlSchema } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as cancel } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { POST as claim } from "../src/app/api/claim/route";
import { POST as exit } from "../src/app/api/exit/route";
import { GET as sync } from "../src/app/api/sync/route";
import { GET as health } from "../src/app/api/health/route";
import {
  call,
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  type TestEnv,
  type TestStaff,
} from "./helpers";

const { scans, tickets } = mysqlSchema;

describe.skipIf(!dbAvailable)("POST /api/claim, /api/exit, GET /api/sync (MariaDB)", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let supervisor: TestStaff;
  let staff: TestStaff;
  let eventId: number;
  let gateA: { id: string; token: string };
  let both: { id: string; token: string };
  let exitOnly: { id: string; token: string };

  async function enrolDevice(gate: string, direction: string) {
    const created = await call(enroll, {
      staff: supervisor,
      body: { event_id: eventId, gate, direction },
    });
    const decoded = decodeSetupCode(created.json.setup_qr);
    if (!decoded.ok) throw new Error("bad setup qr");
    const id = randomUUID();
    const res = await call(enroll, { body: { code: decoded.setup.code, device_id: id } });
    expect(res.status).toBe(200);
    return { id, token: res.json.device_token as string };
  }

  async function ticket(type: number): Promise<string> {
    const res = await call(generate, {
      staff,
      params: { id: String(eventId) },
      body: { idempotency_key: newKey(), ticket_type: type, holder_name: `T${type}` },
    });
    expect(res.status).toBe(201);
    return res.json.tickets[0].ticket_id;
  }

  const body = (device: { id: string }, ticketId: string, extra: Record<string, unknown> = {}) => ({
    scan_id: randomUUID(),
    ticket_id: ticketId,
    device_id: device.id,
    staff_id: staff.id,
    gate: "Gate A",
    scanned_at: env.clock.now,
    ...extra,
  });
  const doClaim = (device: { id: string; token: string }, b: Record<string, unknown>) =>
    call(claim, { bearer: device.token, body: b });
  const doExit = (device: { id: string; token: string }, b: Record<string, unknown>) =>
    call(exit, { bearer: device.token, body: b });
  const row = async (id: string) =>
    (
      await env.handle.db
        .select()
        .from(tickets)
        .where(eq(tickets.id, Buffer.from(hexToBytes(id))))
    )[0]!;

  beforeAll(async () => {
    env = await createTestEnv();
    [admin, supervisor, staff] = await Promise.all([
      makeStaff(env, "admin"),
      makeStaff(env, "supervisor"),
      makeStaff(env, "staff"),
    ]);
    eventId = (
      await call(createEvent, {
        staff: admin,
        body: eventBody(env.clock.now + 86400, {
          ticket_types: [
            { idx: 0, name: "Single" },
            { idx: 1, name: "Limited", entry_rule: { mode: "limited", max_admits: 3 } },
            { idx: 2, name: "Unlimited", entry_rule: { mode: "unlimited" } },
          ],
        }),
      })
    ).json.id;
    gateA = await enrolDevice("Gate A", "entry");
    both = await enrolDevice("Gate B", "both");
    exitOnly = await enrolDevice("Gate B", "exit");
  });
  afterAll(() => env.close());

  it("needs a device token and a matching device_id; direction is enforced", async () => {
    const t = await ticket(0);
    expect((await call(claim, { body: body(gateA, t) })).status).toBe(401);
    expect((await doClaim(gateA, body({ id: randomUUID() }, t))).status).toBe(403);
    expect((await doClaim(exitOnly, body(exitOnly, t))).json.error.code).toBe("wrong_direction");
    expect((await doExit(gateA, body(gateA, t))).json.error.code).toBe("wrong_direction");
    expect((await doClaim(gateA, body(gateA, t, { staff_id: randomUUID() }))).status).toBe(400);
    expect((await doClaim(gateA, body(gateA, "00".repeat(16)))).status).toBe(404);
    expect((await doClaim(gateA, { nope: 1 })).status).toBe(400);
  });

  it("admits a single-entry ticket once; the second scan shows where it was used", async () => {
    const t = await ticket(0);
    const first = body(gateA, t);
    env.clock.now += 5;
    const a = await doClaim(gateA, first);
    expect(a.status).toBe(200);
    expect(() => api.claimResponse.parse(a.json)).not.toThrow();
    expect(a.json).toMatchObject({ result: "admitted", admits_used: 1, limit: 1 });
    expect(await row(t)).toMatchObject({ admitsUsed: 1, inside: true, status: "used_up" });

    const b = await doClaim(gateA, body(gateA, t, { scanned_at: env.clock.now + 60 }));
    expect(b.json.result).toBe("rejected_inside");
    expect(b.json.first_scan).toEqual({ gate: "Gate A", at: first.scanned_at, device: gateA.id });
    const results = (
      await env.handle.db
        .select()
        .from(scans)
        .where(eq(scans.ticketId, Buffer.from(hexToBytes(t))))
    )
      .map((s) => s.result)
      .sort();
    expect(results).toEqual(["admitted", "rejected_inside"]);
  });

  it("a single-entry ticket that exits stays used (grey), and re-entry is refused", async () => {
    const t = await ticket(0);
    await doClaim(both, body(both, t));
    const out = await doExit(both, body(both, t));
    expect(out.json).toEqual({ result: "no_reentry" });
    expect(() => api.exitResponse.parse(out.json)).not.toThrow();
    expect(await row(t)).toMatchObject({ inside: true }); // no state change
    expect((await doClaim(both, body(both, t))).json.result).toBe("rejected_inside");
  });

  it("limited tickets need an exit before each re-entry and run out after N admits", async () => {
    const t = await ticket(1);
    expect((await doClaim(both, body(both, t))).json).toMatchObject({
      result: "admitted",
      admits_used: 1,
      limit: 3,
    });
    expect((await doClaim(both, body(both, t))).json.result).toBe("rejected_inside");
    expect((await doExit(both, body(both, t))).json).toEqual({ result: "exited", entries_left: 2 });
    expect((await doClaim(both, body(both, t))).json.admits_used).toBe(2);
    await doExit(both, body(both, t));
    const third = await doClaim(both, body(both, t));
    expect(third.json).toMatchObject({ result: "admitted", admits_used: 3, limit: 3 });
    expect(await row(t)).toMatchObject({ status: "used_up", inside: true });
    // A used-up limited ticket can still exit, then is refused as used.
    expect((await doExit(both, body(both, t))).json).toEqual({ result: "exited", entries_left: 0 });
    const again = await doClaim(both, body(both, t));
    expect(again.json.result).toBe("rejected_used");
    expect(again.json.first_scan).toBeDefined();
  });

  it("unlimited tickets re-enter after each exit with no cap", async () => {
    const t = await ticket(2);
    for (let i = 1; i <= 6; i++) {
      expect((await doClaim(both, body(both, t))).json).toMatchObject({
        result: "admitted",
        admits_used: i,
        limit: null,
      });
      expect((await doExit(both, body(both, t))).json).toEqual({
        result: "exited",
        entries_left: null,
      });
    }
  });

  it("exiting a ticket that is not inside is logged without changing it", async () => {
    const t = await ticket(2);
    expect((await doExit(both, body(both, t))).json.result).toBe("exited");
    expect(await row(t)).toMatchObject({ inside: false, admitsUsed: 0 });
  });

  it("refuses a cancelled ticket on entry and exit, and logs it as rejected", async () => {
    const t = await ticket(2);
    await call(cancel, { staff: admin, params: { id: t }, body: {} });
    expect((await doClaim(both, body(both, t))).json).toEqual({ result: "rejected_cancelled" });
    expect((await doExit(both, body(both, t))).json).toEqual({ result: "rejected_cancelled" });
    expect(await row(t)).toMatchObject({ admitsUsed: 0, inside: false, status: "cancelled" });
  });

  it("replaying a scan_id returns the same verdict and changes nothing", async () => {
    const t = await ticket(1);
    const b = body(both, t);
    const first = await doClaim(both, b);
    const replay = await doClaim(both, b);
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(first.json);
    expect(await row(t)).toMatchObject({ admitsUsed: 1 });
    expect(await env.handle.db.select().from(scans).where(eq(scans.id, b.scan_id))).toHaveLength(1);

    const rejected = body(both, t);
    const r1 = await doClaim(both, rejected);
    expect(r1.json.result).toBe("rejected_inside");
    expect((await doClaim(both, rejected)).json.result).toBe("rejected_inside");

    const x = body(both, t);
    const e1 = await doExit(both, x);
    expect((await doExit(both, x)).json).toEqual(e1.json);
    expect(await row(t)).toMatchObject({ inside: false });
    // The same id for another ticket is a client bug, not a replay.
    expect((await doClaim(both, { ...b, ticket_id: await ticket(2) })).status).toBe(409);
  });

  it("20 parallel claims of one single-entry ticket admit exactly one", async () => {
    const t = await ticket(0);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        doClaim(i % 2 ? gateA : both, body(i % 2 ? gateA : both, t)),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const verdicts = results.map((r) => r.json.result as string);
    expect(verdicts.filter((v) => v === "admitted")).toHaveLength(1);
    expect(verdicts.filter((v) => v === "rejected_inside")).toHaveLength(19);
    expect(await row(t)).toMatchObject({ admitsUsed: 1, inside: true });
  });

  it("20 parallel claims of one unlimited ticket also admit exactly one until it exits", async () => {
    const t = await ticket(2);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => doClaim(both, body(both, t))),
    );
    expect(results.filter((r) => r.json.result === "admitted")).toHaveLength(1);
    expect(await row(t)).toMatchObject({ admitsUsed: 1 });
  });

  it("parallel replays of one scan_id admit once", async () => {
    const t = await ticket(1);
    const b = body(both, t);
    const results = await Promise.all(Array.from({ length: 10 }, () => doClaim(both, b)));
    expect(results.every((r) => r.status === 200 && r.json.result === "admitted")).toBe(true);
    expect(await row(t)).toMatchObject({ admitsUsed: 1 });
  });

  describe("supervisor override", () => {
    it("needs a supervisor's staff_id, records `override`, and still obeys one-time use", async () => {
      const t = await ticket(0);
      expect((await doClaim(both, body(both, t, { override: true }))).status).toBe(403); // staff
      expect((await doClaim(both, body(both, t, { override: true, staff_id: null }))).status).toBe(
        400,
      );
      const ok = await doClaim(both, body(both, t, { override: true, staff_id: supervisor.id }));
      expect(ok.json.result).toBe("admitted");
      const [s] = await env.handle.db
        .select()
        .from(scans)
        .where(eq(scans.ticketId, Buffer.from(hexToBytes(t))));
      expect(s).toMatchObject({ result: "override", staffId: supervisor.id });
      expect(
        (await doClaim(both, body(both, t, { override: true, staff_id: supervisor.id }))).json
          .result,
      ).toBe("rejected_inside");
    });
  });

  describe("GET /api/sync", () => {
    it("returns ticket changes with admits_used and inside, types, own settings and server time", async () => {
      const t = await ticket(1);
      await doClaim(both, body(both, t));
      const res = await call(sync, { bearer: gateA.token });
      expect(res.status).toBe(200);
      const parsed = api.hubSyncResponse.parse(res.json);
      expect(parsed.hub_time).toBe(env.clock.now);
      expect(parsed.devices).toEqual([
        { id: gateA.id, gate: "Gate A", direction: "entry", revoked: false },
      ]);
      expect(parsed.ticket_types.map((x) => x.name)).toEqual(["Single", "Limited", "Unlimited"]);
      expect(parsed.ticket_types[0]!.early_entry_min).toBe(15);
      expect(parsed.tickets.find((x) => x.id === t)).toMatchObject({
        admits_used: 1,
        inside: true,
        status: "valid",
      });
      // Cursor paging: nothing newer after the last cursor.
      const next = await call(sync, {
        bearer: gateA.token,
        query: { cursor: parsed.next_cursor! },
      });
      expect(next.json.tickets).toEqual([]);
      expect((await call(sync)).status).toBe(401);
    });
  });

  it("GET /api/health is public and shaped like the hub's", async () => {
    const res = await call(health);
    expect(() => api.healthResponse.parse(res.json)).not.toThrow();
  });
});
