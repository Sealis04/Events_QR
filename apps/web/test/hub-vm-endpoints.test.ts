import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, decodeSetupCode, mysqlSchema } from "@events-qr/core";
import { POST as vmClaim } from "../src/app/api/claim/route";
import { POST as enrollRoute } from "../src/app/api/devices/enroll/route";
import { POST as hubSetup } from "../src/app/api/hubs/setup/route";
import { POST as hubEnroll } from "../src/app/api/hubs/enroll/route";
import { GET as syncMeta } from "../src/app/api/sync/meta/route";
import { GET as syncScansGet } from "../src/app/api/sync/scans/route";
import { POST as syncDevices } from "../src/app/api/sync/devices/route";
import { GET as syncTickets } from "../src/app/api/sync/tickets/route";
import { getLink } from "../src/hub/state";
import { sha256Hex } from "../src/server/secrets";
import { call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

describe.skipIf(!dbAvailable)("the VM's hub endpoints", () => {
  let env: TestEnv;
  let w: HubWorld;
  let hubToken: string;

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    hubToken = getLink(w.hub)!.token;
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  it("only a supervisor can create a hub setup code; it is stored hashed and expires in 10 minutes", async () => {
    const body = { event_id: w.eventId, label: "spare hub" };
    expect((await call(hubSetup, { body })).status).toBe(401);
    expect((await call(hubSetup, { staff: w.staff, body })).status).toBe(403);
    const res = await call(hubSetup, { staff: w.supervisor, body });
    expect(res.status).toBe(201);
    expect(() => api.hubSetupResponse.parse(res.json)).not.toThrow();
    expect(res.json.expires_at).toBe(env.clock.now + 600);
    const [row] = await env.handle.db
      .select()
      .from(mysqlSchema.enrolmentCodes)
      .where(eq(mysqlSchema.enrolmentCodes.codeHash, sha256Hex(res.json.setup_code)));
    expect(row).toMatchObject({ kind: "hub", eventId: w.eventId });
    expect((await call(hubSetup, { staff: w.supervisor, body: { event_id: 9999 } })).status).toBe(
      404,
    );
  });

  it("a hub code enrols a hub (key bundle without any signing secret); a phone code cannot enrol a hub and the reverse", async () => {
    const hubCode = (await call(hubSetup, { staff: w.supervisor, body: { event_id: w.eventId } }))
      .json.setup_code as string;
    const phoneQr = (
      await call(enrollRoute, {
        staff: w.supervisor,
        body: { event_id: w.eventId, gate: "Gate A", direction: "entry" },
      })
    ).json.setup_qr as string;
    const phoneCode = (() => {
      const d = decodeSetupCode(phoneQr);
      if (!d.ok) throw new Error("bad qr");
      return d.setup.code;
    })();

    expect(
      (await call(hubEnroll, { body: { code: phoneCode, device_id: randomUUID() } })).status,
    ).toBe(401);
    expect(
      (await call(enrollRoute, { body: { code: hubCode, device_id: randomUUID() } })).status,
    ).toBe(401);

    const id = randomUUID();
    const ok = await call(hubEnroll, { body: { code: hubCode, device_id: id } });
    expect(ok.status).toBe(200);
    const parsed = api.enrollExchangeResponse.parse(ok.json);
    expect(Object.keys(parsed.key_bundle).sort()).toEqual(
      [
        "cloud_url",
        "day_zero",
        "ends_at",
        "event_id",
        "event_key",
        "gates",
        "public_keys",
        "starts_at",
        "ticket_types",
      ].sort(),
    );
    const [row] = await env.handle.db
      .select()
      .from(mysqlSchema.devices)
      .where(eq(mysqlSchema.devices.id, id));
    expect(row).toMatchObject({ kind: "hub", direction: "both" });
  });

  it("the sync endpoints for the hub refuse a phone's token", async () => {
    const phone = await w.enrolAtVm("Gate A", "entry");
    expect((await call(syncMeta, { bearer: phone.token })).status).toBe(403);
    expect((await call(syncScansGet, { bearer: phone.token })).status).toBe(403);
    expect((await call(syncDevices, { bearer: phone.token, body: { devices: [] } })).status).toBe(
      403,
    );
    expect((await call(syncMeta)).status).toBe(401);
    // And the hub's token cannot scan.
    const t = await w.makeTicket(0);
    const res = await call(vmClaim, {
      bearer: hubToken,
      body: w.scanBody({ id: getLink(w.hub)!.deviceId, token: hubToken }, t.id),
    });
    expect(res.status).toBe(403);
  });

  it("GET /sync/meta carries the event, types, staff with PIN hashes, scanner devices and unused phone codes", async () => {
    await w.enrolAtVm("Gate B", "both");
    await call(enrollRoute, {
      staff: w.supervisor,
      body: { event_id: w.eventId, gate: "Gate A", direction: "entry", label: "pending" },
    });
    const res = await call(syncMeta, { bearer: hubToken });
    expect(res.status).toBe(200);
    const meta = api.syncMetaResponse.parse(res.json);
    expect(meta.event).toMatchObject({ id: w.eventId, name: "Summer Fest" });
    expect(meta.ticket_types.map((t) => t.name)).toEqual(["Single", "Limited", "Unlimited"]);
    expect(meta.staff.find((s) => s.id === w.supervisor.id)!.pin_hash).toMatch(/^\$argon2id\$/);
    expect(meta.devices.every((d) => d.token_hash.length === 64)).toBe(true);
    expect(meta.devices.map((d) => d.id)).not.toContain(getLink(w.hub)!.deviceId); // hubs are not scanners
    expect(meta.enrolment_codes.map((c) => c.label)).toContain("pending");
    expect(meta.server_time).toBe(env.clock.now);
  });

  it("GET /sync/scans pages by (received_at, id) and only shows this event's scans", async () => {
    const phone = await w.enrolAtVm("Gate A", "entry");
    const tickets = await Promise.all([0, 0, 0].map((t) => w.makeTicket(t)));
    for (const t of tickets) {
      env.clock.now += 1;
      await call(vmClaim, { bearer: phone.token, body: w.scanBody(phone, t.id) });
    }
    env.clock.now += 2;
    const first = await call(syncScansGet, { bearer: hubToken, query: { limit: 2 } });
    const page1 = api.syncVmScansResponse.parse(first.json);
    expect(page1.scans).toHaveLength(2);
    const seen = new Set(page1.scans.map((s) => s.scan_id));
    let cursor = page1.next_cursor;
    let more = page1.has_more;
    while (more) {
      const next = api.syncVmScansResponse.parse(
        (await call(syncScansGet, { bearer: hubToken, query: { limit: 2, cursor: cursor! } })).json,
      );
      for (const s of next.scans) {
        expect(seen.has(s.scan_id)).toBe(false);
        seen.add(s.scan_id);
      }
      cursor = next.next_cursor;
      more = next.has_more;
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it("POST /sync/devices is idempotent, marks the code used and refuses a gate the event lacks", async () => {
    const created = await call(enrollRoute, {
      staff: w.supervisor,
      body: { event_id: w.eventId, gate: "Gate A", direction: "entry" },
    });
    const decoded = decodeSetupCode(created.json.setup_qr);
    if (!decoded.ok) throw new Error("bad qr");
    const id = randomUUID();
    const device = {
      id,
      gate: "Gate A",
      direction: "entry",
      label: null,
      token_hash: sha256Hex("x"),
      code_hash: sha256Hex(decoded.setup.code),
      enrolled_at: env.clock.now,
    };
    const a = await call(syncDevices, { bearer: hubToken, body: { devices: [device] } });
    const b = await call(syncDevices, { bearer: hubToken, body: { devices: [device] } });
    expect(a.json.acknowledged).toEqual([id]);
    expect(b.json.acknowledged).toEqual([id]);
    const rows = await env.handle.db
      .select()
      .from(mysqlSchema.devices)
      .where(eq(mysqlSchema.devices.id, id));
    expect(rows).toHaveLength(1);
    const [code] = await env.handle.db
      .select()
      .from(mysqlSchema.enrolmentCodes)
      .where(eq(mysqlSchema.enrolmentCodes.codeHash, sha256Hex(decoded.setup.code)));
    expect(code).toMatchObject({ usedAt: env.clock.now, deviceId: id });
    // The one-time code now fails at the VM too.
    expect(
      (await call(enrollRoute, { body: { code: decoded.setup.code, device_id: randomUUID() } }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(syncDevices, {
          bearer: hubToken,
          body: { devices: [{ ...device, id: randomUUID(), gate: "Nowhere" }] },
        })
      ).status,
    ).toBe(400);
  });

  it("existing ticket sync still works with the hub's token", async () => {
    const res = await call(syncTickets, { bearer: hubToken, query: { limit: 5 } });
    expect(() => api.syncTicketsResponse.parse(res.json)).not.toThrow();
  });
});
