/**
 * Long-lived hub setup codes (user decision 2026-10-22): a batch of single-use phone codes made
 * for the hub lasts until the event ends, so phones can be set up at the venue with no internet.
 * Normal on-screen codes keep their 10 minutes.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { api, decodeSetupCode, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { SETUP_TTL_SECONDS } from "../src/server/constants";
import { sha256Hex } from "../src/server/secrets";
import * as hubRoutes from "../src/hub/routes";
import { call, createTestEnv, dbAvailable, makeStaff, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

describe.skipIf(!dbAvailable)("hub setup codes that last all event", () => {
  let env: TestEnv;
  let w: HubWorld;
  let endsAt = 0;

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    const row = (await env.handle.db.select().from(mysqlSchema.events))[0]!;
    endsAt = row.endsAt;
  });
  beforeEach(() => w.restoreUplink());
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  const makeBatch = (body: Record<string, unknown> = {}, staff = w.supervisor) =>
    call(enroll, {
      staff,
      body: { event_id: w.eventId, gate: "Gate A", direction: "entry", ...body },
    });
  const codesOf = (qrs: string[]) =>
    qrs.map((q) => {
      const d = decodeSetupCode(q);
      if (!d.ok) throw new Error("bad qr");
      return d.setup.code;
    });
  const hubEnrol = (code: string, id = randomUUID()) =>
    call(hubRoutes.enroll, { body: { code, device_id: id } });
  const vmEnrol = (code: string, id = randomUUID()) =>
    call(enroll, { body: { code, device_id: id } });

  it("makes a batch valid until the event ends; normal codes keep 10 minutes; staff cannot", async () => {
    const batch = await makeBatch({ for_hub: true, count: 10, label: "box 1" });
    expect(batch.status).toBe(201);
    expect(() => api.createSetupResponse.parse(batch.json)).not.toThrow();
    expect(batch.json.setup_qrs).toHaveLength(10);
    expect(new Set(batch.json.setup_qrs).size).toBe(10);
    expect(batch.json.setup_qr).toBe(batch.json.setup_qrs[0]);
    expect(batch.json.expires_at).toBe(endsAt);
    // Stored hashed, all with the event's end as expiry.
    const rows = await env.handle.db
      .select()
      .from(mysqlSchema.enrolmentCodes)
      .where(eq(mysqlSchema.enrolmentCodes.label, "box 1"));
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.expiresAt === endsAt && r.kind === "scanner")).toBe(true);
    for (const code of codesOf(batch.json.setup_qrs))
      expect(rows.some((r) => r.codeHash === sha256Hex(code))).toBe(true);

    const normal = await makeBatch();
    expect(normal.json.expires_at).toBe(env.clock.now + SETUP_TTL_SECONDS);
    expect(normal.json.setup_qrs).toHaveLength(1);

    expect((await makeBatch({ count: 5 })).status).toBe(400); // batches are for the hub only
    expect((await makeBatch({ for_hub: true, count: 51 })).status).toBe(400);
    expect((await makeBatch({ for_hub: true }, w.staff)).status).toBe(403);
  });

  it("the hub caches them; hours later, with no internet, each enrols exactly one phone", async () => {
    const batch = await makeBatch({ for_hub: true, count: 3, label: "offline box" });
    const [a, b] = codesOf(batch.json.setup_qrs);
    await w.pull();
    const cached = w.hub.db.select().from(sqliteSchema.enrolmentCodes).all();
    expect(cached.filter((c) => c.expiresAt === endsAt).length).toBeGreaterThanOrEqual(3);

    w.cutUplink();
    env.clock.now += 3 * 3600; // far past the 10-minute window of a normal code
    const phone = randomUUID();
    const res = await hubEnrol(a!, phone);
    expect(res.status).toBe(200);
    expect(() => api.enrollExchangeResponse.parse(res.json)).not.toThrow();
    // Single use at the hub ...
    expect((await hubEnrol(a!)).status).toBe(401);
    // ... but another code of the batch still works.
    expect((await hubEnrol(b!)).status).toBe(200);
  });

  it("a code used at the hub is refused on the VM after the next sync, and the phone works there", async () => {
    const batch = await makeBatch({ for_hub: true, count: 1, label: "hub then vm" });
    const [code] = codesOf(batch.json.setup_qrs);
    await w.pull();
    const phone = randomUUID();
    const res = await hubEnrol(code!, phone);
    expect(res.status).toBe(200);
    await w.push();
    const [row] = await env.handle.db
      .select()
      .from(mysqlSchema.enrolmentCodes)
      .where(eq(mysqlSchema.enrolmentCodes.codeHash, sha256Hex(code!)));
    expect(row!.usedAt).not.toBeNull();
    expect(row!.deviceId).toBe(phone);
    expect((await vmEnrol(code!)).status).toBe(401);
  });

  it("a code used on the VM is refused at the hub after the next pull", async () => {
    const batch = await makeBatch({ for_hub: true, count: 1, label: "vm then hub" });
    const [code] = codesOf(batch.json.setup_qrs);
    await w.pull();
    expect((await vmEnrol(code!)).status).toBe(200);
    await w.pull();
    expect((await hubEnrol(code!)).status).toBe(401);
  });

  it("normal codes still die after 10 minutes at the hub, and hub codes die when the event ends", async () => {
    const normal = await makeBatch({ label: "normal" });
    const hubBatch = await makeBatch({ for_hub: true, count: 1, label: "until end" });
    await w.pull();
    const [n] = codesOf(normal.json.setup_qrs);
    const [h] = codesOf(hubBatch.json.setup_qrs);
    env.clock.now += SETUP_TTL_SECONDS + 5;
    expect((await hubEnrol(n!)).status).toBe(401);
    env.clock.now = endsAt + 1;
    expect((await hubEnrol(h!)).status).toBe(401);
  });

  it("refuses a hub batch once the event has ended", async () => {
    env.clock.now = endsAt + 10;
    const late = await makeStaff(env, "supervisor"); // the old session has expired by now
    expect((await makeBatch({ for_hub: true, count: 2 }, late)).status).toBe(400);
  });
});
