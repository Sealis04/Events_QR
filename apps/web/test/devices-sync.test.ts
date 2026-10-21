import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, decodeSetupCode, hexToBytes, mysqlSchema, verifyToken } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { GET as stats } from "../src/app/api/events/[id]/stats/route";
import { POST as cancel } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { GET as syncTickets } from "../src/app/api/sync/tickets/route";
import { POST as syncScans } from "../src/app/api/sync/scans/route";
import { fromB64, sha256Hex } from "../src/server/secrets";
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

const { devices, enrolmentCodes, scans, tickets } = mysqlSchema;

describe.skipIf(!dbAvailable)("device enrolment, ticket sync and scan upload (MariaDB)", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let supervisor: TestStaff;
  let staff: TestStaff;
  let eventId: number;
  let otherEventId: number;

  const gen = async (body: Record<string, unknown>, id = eventId) => {
    const res = await call(generate, {
      staff,
      params: { id: String(id) },
      body: { idempotency_key: newKey(), ...body },
    });
    expect(res.status).toBe(201);
    return res.json.tickets as { ticket_id: string; token: string }[];
  };
  const setup = (body: Record<string, unknown> = {}, who: TestStaff = supervisor) =>
    call(enroll, {
      staff: who,
      body: {
        event_id: eventId,
        gate: "Gate A",
        direction: "entry",
        label: "Gate A – phone 1",
        ...body,
      },
    });
  const exchange = (code: string, deviceId = randomUUID()) =>
    call(enroll, { body: { code, device_id: deviceId } });
  const codeOf = (setupQr: string) => {
    const decoded = decodeSetupCode(setupQr);
    if (!decoded.ok) throw new Error("bad setup qr");
    return decoded.setup;
  };

  /** Enrols a device through the real two-step flow. */
  async function enrolDevice(extra: Record<string, unknown> = {}) {
    const created = await setup(extra);
    const { code } = codeOf(created.json.setup_qr);
    const deviceId = randomUUID();
    const res = await exchange(code, deviceId);
    expect(res.status).toBe(200);
    return { deviceId, token: res.json.device_token as string, bundle: res.json };
  }

  beforeAll(async () => {
    env = await createTestEnv();
    [admin, supervisor, staff] = await Promise.all([
      makeStaff(env, "admin"),
      makeStaff(env, "supervisor"),
      makeStaff(env, "staff"),
    ]);
    eventId = (await call(createEvent, { staff: admin, body: eventBody(env.clock.now + 86400) }))
      .json.id;
    otherEventId = (
      await call(createEvent, {
        staff: admin,
        body: eventBody(env.clock.now + 90000, { name: "Other" }),
      })
    ).json.id;
  });
  afterAll(() => env.close());

  describe("POST /devices/enroll", () => {
    it("creates a DEV1: setup QR with a one-time code stored only as a hash, valid for 10 minutes", async () => {
      const res = await setup();
      expect(res.status).toBe(201);
      expect(() => api.createSetupResponse.parse(res.json)).not.toThrow();
      expect(res.json.expires_at).toBe(env.clock.now + 600);
      const setupData = codeOf(res.json.setup_qr);
      expect(setupData).toMatchObject({ eventId, hubUrl: "http://localhost:3000" });
      const rows = await env.handle.db
        .select()
        .from(enrolmentCodes)
        .where(eq(enrolmentCodes.codeHash, sha256Hex(setupData.code)));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        gate: "Gate A",
        direction: "entry",
        createdBy: supervisor.id,
        usedAt: null,
      });
      expect(JSON.stringify(rows)).not.toContain(setupData.code);
    });

    it("uses HUB_URL when configured and rejects unknown gates and events", async () => {
      env.ctx.config.HUB_URL = "https://hub.example.org";
      try {
        const res = await setup();
        expect(codeOf(res.json.setup_qr).hubUrl).toBe("https://hub.example.org");
      } finally {
        env.ctx.config.HUB_URL = undefined;
      }
      expect((await setup({ gate: "Nowhere" })).status).toBe(400);
      expect((await setup({ event_id: 9999 })).status).toBe(404);
    });

    it("exchanges the code for a device token, key bundle, gate and role", async () => {
      const ticket = (await gen({ ticket_type: 2, holder_name: "Scan me" }))[0]!;
      const { deviceId, token, bundle } = await enrolDevice({
        gate: "Gate B",
        direction: "both",
        label: "Gate B – phone 2",
      });
      expect(() => api.enrollExchangeResponse.parse(bundle)).not.toThrow();
      expect(bundle).toMatchObject({
        device_id: deviceId,
        gate: "Gate B",
        direction: "both",
        label: "Gate B – phone 2",
      });
      expect(bundle.key_bundle).toMatchObject({
        event_id: eventId,
        gates: ["Gate A", "Gate B", "VIP door"],
      });

      // The bundle is enough to verify a ticket offline.
      const eventKey = fromB64(bundle.key_bundle.event_key);
      const publicKeys = new Map(
        Object.entries(bundle.key_bundle.public_keys as Record<string, string>).map(([k, v]) => [
          Number(k),
          fromB64(v),
        ]),
      );
      const verified = await verifyToken(ticket.token, publicKeys, eventKey, eventId);
      expect(verified.ok).toBe(true);

      const [row] = await env.handle.db.select().from(devices).where(eq(devices.id, deviceId));
      expect(row!.tokenHash).toBe(sha256Hex(token));
      expect(row!.tokenHash).not.toBe(token);
      expect(row).toMatchObject({ eventId, gate: "Gate B", direction: "both", revoked: false });
    });

    it("a code works once", async () => {
      const { code } = codeOf((await setup()).json.setup_qr);
      expect((await exchange(code)).status).toBe(200);
      const again = await exchange(code); // a different phone
      expect(again.status).toBe(401);
      expect(again.json.error.code).toBe("invalid_code");
    });

    it("a code expires after 10 minutes", async () => {
      const { code } = codeOf((await setup()).json.setup_qr);
      env.clock.now += 601;
      try {
        expect((await exchange(code)).status).toBe(401);
      } finally {
        env.clock.now -= 601;
      }
      expect((await exchange("never-issued")).status).toBe(401);
    });

    it("lets the same phone retry after a lost response, rotating its token", async () => {
      const { code } = codeOf((await setup()).json.setup_qr);
      const deviceId = randomUUID();
      const first = await exchange(code, deviceId);
      const retry = await exchange(code, deviceId);
      expect(retry.status).toBe(200);
      expect(retry.json.device_token).not.toBe(first.json.device_token);
      expect((await call(syncTickets, { bearer: first.json.device_token })).status).toBe(401);
      expect((await call(syncTickets, { bearer: retry.json.device_token })).status).toBe(200);
      // Another phone still can't use the used code.
      expect((await exchange(code, randomUUID())).status).toBe(401);
    });

    it("refuses a device id that is already enrolled under another code", async () => {
      const { deviceId } = await enrolDevice();
      const { code } = codeOf((await setup()).json.setup_qr);
      expect((await exchange(code, deviceId)).status).toBe(409);
    });

    it("a revoked device stops syncing", async () => {
      const { deviceId, token } = await enrolDevice();
      expect((await call(syncTickets, { bearer: token })).status).toBe(200);
      await env.handle.db.update(devices).set({ revoked: true }).where(eq(devices.id, deviceId));
      expect((await call(syncTickets, { bearer: token })).status).toBe(401);
      // ...and a retry of the old code does not bring it back.
      expect((await call(syncTickets, { bearer: `${deviceId}.wrong` })).status).toBe(401);
    });
  });

  describe("GET /sync/tickets", () => {
    let token: string;
    beforeAll(async () => {
      token = (await enrolDevice()).token;
    });

    const pull = (query: Record<string, string | number> = {}) =>
      call(syncTickets, { bearer: token, query });

    it("pages with a monotonic (updated_at, id) cursor and sees every ticket exactly once", async () => {
      const made: string[] = [];
      for (let i = 0; i < 7; i++) {
        env.clock.now += i % 3 === 0 ? 1 : 0; // some share a second, some don't
        made.push(
          ...(await gen({ ticket_type: 2, holder_name: `Sync ${i}` })).map((t) => t.ticket_id),
        );
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const res = await pull({ limit: 3, ...(cursor ? { cursor } : {}) });
        expect(res.status).toBe(200);
        expect(() => api.syncTicketsResponse.parse(res.json)).not.toThrow();
        seen.push(...res.json.tickets.map((t: { id: string }) => t.id));
        pages += 1;
        if (res.json.next_cursor) cursor = res.json.next_cursor;
        if (!res.json.has_more) break;
      }
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
      for (const id of made) expect(seen).toContain(id);

      const ordered = (await pull({ limit: 1000 })).json.tickets as {
        id: string;
        updated_at: number;
      }[];
      const keys = ordered.map((t) => [t.updated_at, t.id] as const);
      expect(keys).toEqual([...keys].sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1)));
    });

    it("an up-to-date cursor returns nothing and keeps no new cursor", async () => {
      const all = await pull({ limit: 1000 });
      const idle = await pull({ cursor: all.json.next_cursor });
      expect(idle.json).toEqual({ tickets: [], next_cursor: null, has_more: false });
    });

    it("a cancelled ticket appears in the next sync page", async () => {
      const t = (await gen({ ticket_type: 2, holder_name: "Soon cancelled" }))[0]!;
      const before = await pull({ limit: 1000 });
      env.clock.now += 5;
      await call(cancel, { staff: admin, params: { id: t.ticket_id }, body: {} });
      const next = await pull({ cursor: before.json.next_cursor });
      expect(next.json.tickets).toHaveLength(1);
      expect(next.json.tickets[0]).toMatchObject({
        id: t.ticket_id,
        status: "cancelled",
        updated_at: env.clock.now,
      });
    });

    it("holds back rows younger than the sync horizon", async () => {
      const t = (await gen({ ticket_type: 2, holder_name: "Too fresh" }))[0]!;
      env.ctx.config.SYNC_HORIZON_SECONDS = 2;
      try {
        const early = await pull({ limit: 1000 });
        expect(early.json.tickets.map((x: { id: string }) => x.id)).not.toContain(t.ticket_id);
        env.clock.now += 3;
        const later = await pull({ limit: 1000 });
        expect(later.json.tickets.map((x: { id: string }) => x.id)).toContain(t.ticket_id);
      } finally {
        env.ctx.config.SYNC_HORIZON_SECONDS = 0;
      }
    });

    it("only serves the device's own event and validates the cursor", async () => {
      const foreign = (await gen({ ticket_type: 2, holder_name: "Elsewhere" }, otherEventId))[0]!;
      const all = (await pull({ limit: 1000 })).json.tickets as { id: string }[];
      expect(all.map((t) => t.id)).not.toContain(foreign.ticket_id);
      expect((await pull({ cursor: "garbage" })).status).toBe(400);
      expect((await pull({ limit: 0 })).status).toBe(400);
    });
  });

  describe("POST /sync/scans", () => {
    let token: string;
    let deviceId: string;
    beforeAll(async () => {
      ({ token, deviceId } = await enrolDevice());
    });

    const scan = (ticketId: string, over: Record<string, unknown> = {}) => ({
      scan_id: randomUUID(),
      ticket_id: ticketId,
      device_id: deviceId,
      staff_id: staff.id,
      gate: "Gate A",
      direction: "entry",
      scanned_at: env.clock.now,
      result: "admitted",
      offline: false,
      ...over,
    });
    const upload = (batch: unknown[]) => call(syncScans, { bearer: token, body: { scans: batch } });
    const state = async (ticketId: string) => {
      const [row] = await env.handle.db
        .select()
        .from(tickets)
        .where(eq(tickets.id, Buffer.from(hexToBytes(ticketId))));
      return row!;
    };
    const flagged = async (ticketId: string) =>
      (
        await env.handle.db
          .select()
          .from(scans)
          .where(eq(scans.ticketId, Buffer.from(hexToBytes(ticketId))))
      )
        .filter((s) => s.conflict)
        .map((s) => s.id);

    it("acknowledges scans, updates the ticket and is idempotent on scan id", async () => {
      const t = (await gen({ ticket_type: 0, holder_name: "Walk in" }))[0]!;
      const s = scan(t.ticket_id);
      const first = await upload([s]);
      expect(first.status).toBe(200);
      expect(() => api.syncScansResponse.parse(first.json)).not.toThrow();
      expect(first.json).toEqual({ acknowledged: [s.scan_id], conflicts: [] });
      expect(await state(t.ticket_id)).toMatchObject({
        admitsUsed: 1,
        inside: true,
        status: "used_up",
      });

      const replay = await upload([s, s]);
      expect(replay.json).toEqual(first.json);
      const rows = await env.handle.db.select().from(scans).where(eq(scans.id, s.scan_id));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        deviceId,
        staffId: staff.id,
        receivedAt: env.clock.now,
        gate: "Gate A",
      });
      expect(await state(t.ticket_id)).toMatchObject({ admitsUsed: 1 });
    });

    it("flags the later of two admits on a single-entry ticket, whatever order they arrive in", async () => {
      const t = (await gen({ ticket_type: 0, holder_name: "Shared screenshot" }))[0]!;
      const late = scan(t.ticket_id, {
        scanned_at: env.clock.now + 30,
        gate: "Gate B",
        offline: true,
      });
      const early = scan(t.ticket_id, {
        scanned_at: env.clock.now + 5,
        gate: "Gate A",
        offline: true,
      });

      const one = await upload([late]);
      expect(one.json.conflicts).toEqual([]); // nothing to clash with yet
      const two = await upload([early]);
      expect(two.json.conflicts).toEqual([]); // the new scan is the canonical one...
      expect(await flagged(t.ticket_id)).toEqual([late.scan_id]); // ...and the earlier-arrived one is now the duplicate

      const both = await upload([late, early]);
      expect(both.json.conflicts).toEqual([late.scan_id]);
      expect(both.json.acknowledged.sort()).toEqual([late.scan_id, early.scan_id].sort());
      expect(await state(t.ticket_id)).toMatchObject({
        admitsUsed: 2,
        inside: true,
        status: "used_up",
      });
    });

    it("tracks re-entry tickets through exits and flags admits past the limit", async () => {
      const t = (await gen({ ticket_type: 1, holder_name: "VIP", gate_mask: 0b100 }))[0]!; // limited to 3 entries
      const at = (n: number) => ({ scanned_at: env.clock.now + n });
      const batch = [
        scan(t.ticket_id, { ...at(1) }),
        scan(t.ticket_id, { ...at(2), direction: "exit", result: "exited" }),
        scan(t.ticket_id, { ...at(3) }),
        scan(t.ticket_id, { ...at(4), direction: "exit", result: "exited" }),
        scan(t.ticket_id, { ...at(5), result: "override" }),
      ];
      expect((await upload(batch)).json.conflicts).toEqual([]);
      expect(await state(t.ticket_id)).toMatchObject({
        admitsUsed: 3,
        inside: true,
        status: "used_up",
      });

      const exit = scan(t.ticket_id, { ...at(6), direction: "exit", result: "exited" });
      const fourth = scan(t.ticket_id, { ...at(7) });
      const res = await upload([exit, fourth]);
      expect(res.json.conflicts).toEqual([fourth.scan_id]); // a 4th entry on a 3-entry ticket
      expect(await state(t.ticket_id)).toMatchObject({ admitsUsed: 4, inside: true });
    });

    it("ignores rejected scans for state but keeps the rows", async () => {
      const t = (await gen({ ticket_type: 0, holder_name: "Turned away" }))[0]!;
      const rejected = scan(t.ticket_id, { result: "rejected_inside" });
      expect((await upload([rejected])).json.acknowledged).toEqual([rejected.scan_id]);
      expect(await state(t.ticket_id)).toMatchObject({
        admitsUsed: 0,
        inside: false,
        status: "valid",
      });
    });

    it("does not acknowledge scans of unknown or foreign tickets, and nulls unknown device and staff ids", async () => {
      const foreign = (await gen({ ticket_type: 2, holder_name: "Elsewhere" }, otherEventId))[0]!;
      const unknown = scan("ab".repeat(16));
      const alien = scan(foreign.ticket_id);
      const t = (await gen({ ticket_type: 2, holder_name: "Hub phone" }))[0]!;
      const fromHub = scan(t.ticket_id, { device_id: randomUUID(), staff_id: randomUUID() });
      const res = await upload([unknown, alien, fromHub]);
      expect(res.json.acknowledged).toEqual([fromHub.scan_id]);
      const [row] = await env.handle.db.select().from(scans).where(eq(scans.id, fromHub.scan_id));
      expect(row).toMatchObject({ deviceId: null, staffId: null });
    });

    it("keeps a cancelled ticket cancelled when scans arrive", async () => {
      const t = (await gen({ ticket_type: 0, holder_name: "Cancelled then scanned" }))[0]!;
      await call(cancel, { staff: admin, params: { id: t.ticket_id }, body: {} });
      await upload([scan(t.ticket_id)]);
      expect(await state(t.ticket_id)).toMatchObject({
        status: "cancelled",
        admitsUsed: 1,
        inside: true,
      });
    });

    it("validates the batch", async () => {
      expect((await upload([])).status).toBe(400);
      expect((await upload([{ ...scan("00".repeat(16)), result: "teleported" }])).status).toBe(400);
      expect((await upload(Array.from({ length: 501 }, () => scan("00".repeat(16))))).status).toBe(
        400,
      );
    });
  });

  describe("GET /events/{id}/stats", () => {
    it("counts admits by gate and ticket type, who is inside, conflicts and scans per minute", async () => {
      const fresh = (
        await call(createEvent, {
          staff: admin,
          body: eventBody(env.clock.now + 1000, { name: "Stats" }),
        })
      ).json.id as number;
      const { token, deviceId } = await (async () => {
        const created = await call(enroll, {
          staff: supervisor,
          body: { event_id: fresh, gate: "Gate A", direction: "entry" },
        });
        const deviceId = randomUUID();
        const res = await exchange(codeOf(created.json.setup_qr).code, deviceId);
        return { token: res.json.device_token as string, deviceId };
      })();
      const ga = await gen({ ticket_type: 0, quantity: 3 }, fresh);
      const staffPass = await gen({ ticket_type: 2, holder_name: "Crew" }, fresh);
      const now = env.clock.now;
      const mk = (ticket: string, over: Record<string, unknown>) => ({
        scan_id: randomUUID(),
        ticket_id: ticket,
        device_id: deviceId,
        staff_id: null,
        gate: "Gate A",
        direction: "entry",
        scanned_at: now,
        result: "admitted",
        offline: false,
        ...over,
      });
      const res = await call(syncScans, {
        bearer: token,
        body: {
          scans: [
            mk(ga[0]!.ticket_id, {}),
            mk(ga[1]!.ticket_id, { gate: "Gate B", scanned_at: now - 120 }),
            mk(ga[2]!.ticket_id, { result: "rejected_used" }),
            mk(staffPass[0]!.ticket_id, { scanned_at: now - 4000 }), // older than the per-minute window
            mk(ga[0]!.ticket_id, { scanned_at: now + 10, offline: true }), // duplicate admit
          ],
        },
      });
      expect(res.json.conflicts).toHaveLength(1);

      const out = await call(stats, { staff, params: { id: String(fresh) } });
      expect(out.status).toBe(200);
      expect(() => api.eventStatsResponse.parse(out.json)).not.toThrow();
      expect(out.json).toMatchObject({
        total_admitted: 4,
        inside: 3,
        by_gate: { "Gate A": 3, "Gate B": 1 },
        by_ticket_type: { "0": 3, "2": 1 },
        conflicts: 1,
      });
      const perMinute = out.json.scans_per_minute as { minute: number; count: number }[];
      expect(perMinute.reduce((n, m) => n + m.count, 0)).toBe(3); // the 4000 s old one is outside the last hour
      expect(perMinute.every((m) => m.minute % 60 === 0)).toBe(true);
      expect((await call(stats, { staff, params: { id: "9999" } })).status).toBe(404);
    });
  });
});
