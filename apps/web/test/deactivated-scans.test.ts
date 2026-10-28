/** M13 F1: scans and overrides by a deactivated account (VM and hub). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeSetupCode } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { POST as claim } from "../src/app/api/claim/route";
import { POST as uploadScans } from "../src/app/api/scans/route";
import { GET as conflicts } from "../src/app/api/events/[id]/conflicts/route";
import { updateStaff } from "../src/server/staff";
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
import { createHubWorld, type HubWorld } from "./hub-helpers";

describe.skipIf(!dbAvailable)("deactivated accounts and scans (VM)", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let supervisor: TestStaff;
  let eventId: number;
  let phone: { id: string; token: string };

  const ticket = async () =>
    (
      await call(generate, {
        staff: admin,
        params: { id: String(eventId) },
        body: { idempotency_key: newKey(), ticket_type: 0, holder_name: "Guest" },
      })
    ).json.tickets[0].ticket_id as string;
  const scan = (ticketId: string, scannedAt: number) => ({
    scan_id: randomUUID(),
    ticket_id: ticketId,
    device_id: phone.id,
    staff_id: supervisor.id,
    gate: "Gate A",
    direction: "entry",
    scanned_at: scannedAt,
    result: "override",
    offline: true,
  });
  const listed = async () =>
    (await call(conflicts, { staff: admin, params: { id: String(eventId) } })).json.conflicts as {
      scan_id: string;
      staff_name: string;
      deactivated_account: { deactivated_at: number } | null;
    }[];

  beforeAll(async () => {
    env = await createTestEnv();
    admin = await makeStaff(env, "admin");
    supervisor = await makeStaff(env, "supervisor");
    eventId = (
      await call(createEvent, {
        staff: admin,
        body: eventBody(env.clock.now + 86400, { ticket_types: [{ idx: 0, name: "Single" }] }),
      })
    ).json.id;
    const created = await call(enroll, {
      staff: supervisor,
      body: { event_id: eventId, gate: "Gate A", direction: "entry" },
    });
    const decoded = decodeSetupCode(created.json.setup_qr);
    if (!decoded.ok) throw new Error("bad setup qr");
    const id = randomUUID();
    const res = await call(enroll, { body: { code: decoded.setup.code, device_id: id } });
    phone = { id, token: res.json.device_token };
  });
  afterAll(async () => {
    await env?.close();
  });

  it("refuses an online claim and override by a deactivated account", async () => {
    const t = await ticket();
    const body = (override: boolean) => ({
      scan_id: randomUUID(),
      ticket_id: t,
      device_id: phone.id,
      staff_id: supervisor.id,
      gate: "Gate A",
      scanned_at: env.clock.now,
      override,
    });
    expect((await call(claim, { bearer: phone.token, body: body(false) })).status).toBe(200);
    const t2 = await ticket();
    await updateStaff(env.ctx, admin.id, supervisor.id, { active: false });
    for (const override of [true, false]) {
      const res = await call(claim, {
        bearer: phone.token,
        body: { ...body(override), ticket_id: t2 },
      });
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("staff_deactivated");
    }
    await updateStaff(env.ctx, admin.id, supervisor.id, { active: true });
  });

  it("stores an offline override uploaded after deactivation and flags only that one", async () => {
    const before = env.clock.now;
    env.clock.now += 100;
    await updateStaff(env.ctx, admin.id, supervisor.id, { active: false });
    const deactivatedAt = env.clock.now;
    env.clock.now += 100;
    const early = scan(await ticket(), before);
    const late = scan(await ticket(), deactivatedAt + 50);
    const up = await call(uploadScans, {
      bearer: phone.token,
      body: { scans: [early, late] },
    });
    expect(up.status).toBe(200);
    expect(up.json.acknowledged.sort()).toEqual([early.scan_id, late.scan_id].sort());

    const rows = await listed();
    expect(rows.map((r) => r.scan_id)).toEqual([late.scan_id]);
    expect(rows[0]).toMatchObject({
      staff_name: supervisor.name,
      deactivated_account: { deactivated_at: deactivatedAt },
    });
  });

  it("compares against the deactivation window that covers the scan time", async () => {
    await updateStaff(env.ctx, admin.id, supervisor.id, { active: true });
    const reactivatedAt = env.clock.now;
    env.clock.now += 100;
    const after = scan(await ticket(), reactivatedAt + 10);
    expect(
      (await call(uploadScans, { bearer: phone.token, body: { scans: [after] } })).status,
    ).toBe(200);
    expect((await listed()).map((r) => r.scan_id)).not.toContain(after.scan_id);
  });
});

describe.skipIf(!dbAvailable)("deactivated accounts and scans (hub)", () => {
  let env: TestEnv;
  let world: HubWorld;
  beforeAll(async () => {
    env = await createTestEnv();
    world = await createHubWorld(env);
  });
  afterAll(async () => {
    await world.close();
    await env.close();
  });

  it("refuses a claim by an account the VM deactivated once the hub has synced", async () => {
    const d = await world.enrolAtHub("Gate A", "entry");
    const t = await world.makeTicket(0);
    await world.pull();
    await updateStaff(env.ctx, world.admin.id, world.supervisor.id, { active: false });
    await world.pull();
    for (const override of [true, false]) {
      const res = await world.hubClaim(
        d,
        world.scanBody(d, t.id, { staff_id: world.supervisor.id, override }),
      );
      expect(res.status).toBe(403);
      expect(res.json.error.code).toBe("staff_deactivated");
    }
  });
});
