import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { POST as vmClaim } from "../src/app/api/claim/route";
import { POST as vmLogin } from "../src/app/api/auth/login/route";
import { call, createTestEnv, dbAvailable, TEST_PIN, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";
import * as hubRoutes from "../src/hub/routes";
import { getState } from "../src/hub/state";
import { pendingScanCount, vmClientFor } from "../src/hub/vmsync";
import { VmUnreachable } from "../src/hub/vmclient";

const hubTickets = sqliteSchema.tickets;
const hubScans = sqliteSchema.scans;

describe.skipIf(!dbAvailable)("hub sync with the VM", () => {
  let env: TestEnv;
  let w: HubWorld;

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  const hubRow = (id: string) =>
    w.hub.db
      .select()
      .from(hubTickets)
      .where(eq(hubTickets.id, hexToBytes(id)))
      .get();
  const vmRow = async (id: string) =>
    (
      await env.handle.db
        .select()
        .from(mysqlSchema.tickets)
        .where(eq(mysqlSchema.tickets.id, Buffer.from(hexToBytes(id))))
    )[0];
  const vmScans = (id: string) =>
    env.handle.db
      .select()
      .from(mysqlSchema.scans)
      .where(eq(mysqlSchema.scans.ticketId, Buffer.from(hexToBytes(id))));
  const hubScansOf = (id: string) =>
    w.hub.db
      .select()
      .from(hubScans)
      .where(eq(hubScans.ticketId, hexToBytes(id)))
      .all();
  const deviceSync = (token: string, cursor?: string) =>
    call(hubRoutes.sync, { bearer: token, query: cursor ? { cursor } : {} });

  it("a ticket generated on the VM reaches the hub in one pull and a phone in one device pull; a cancellation does too and is then refused", async () => {
    const phone = await w.enrolAtHub("Gate A", "entry");
    const first = await deviceSync(phone.token);
    expect(() => api.hubSyncResponse.parse(first.json)).not.toThrow();
    const cursor = first.json.next_cursor as string | null;

    const t = await w.makeTicket(0, "Grace Hopper");
    expect(hubRow(t.id)).toBeUndefined();
    await w.pull();
    expect(hubRow(t.id)).toMatchObject({ holderName: "Grace Hopper", status: "valid" });

    env.clock.now += 2;
    const sync = await deviceSync(phone.token, cursor ?? undefined);
    const got = sync.json.tickets.find((x: { id: string }) => x.id === t.id);
    expect(got).toMatchObject({ holder_name: "Grace Hopper", status: "valid", inside: false });
    expect(sync.json.hub_time).toBe(env.clock.now);
    expect(sync.json.devices).toEqual([
      { id: phone.id, gate: "Gate A", direction: "entry", revoked: false },
    ]);
    expect(sync.json.ticket_types.map((x: { name: string }) => x.name)).toEqual([
      "Single",
      "Limited",
      "Unlimited",
    ]);

    await w.cancel(t.id);
    await w.pull();
    expect(hubRow(t.id)?.status).toBe("cancelled");
    env.clock.now += 2;
    const after = await deviceSync(phone.token, sync.json.next_cursor);
    expect(after.json.tickets.find((x: { id: string }) => x.id === t.id)).toMatchObject({
      status: "cancelled",
    });
    expect((await w.hubClaim(phone, w.scanBody(phone, t.id))).json).toEqual({
      result: "rejected_cancelled",
    });
  });

  it("what one gate admits reaches the other phones on their next device pull (admits_used, inside)", async () => {
    const a = await w.enrolAtHub("Gate A", "entry");
    const b = await w.enrolAtHub("Gate B", "entry");
    const t = await w.makeTicket(0, "Shared");
    await w.pull();
    env.clock.now += 2;
    const before = await deviceSync(b.token);
    expect(before.json.tickets.find((x: { id: string }) => x.id === t.id)).toMatchObject({
      inside: false,
      admits_used: 0,
    });
    await w.hubClaim(a, w.scanBody(a, t.id));
    env.clock.now += 2;
    const after = await deviceSync(b.token, before.json.next_cursor);
    expect(after.json.tickets.find((x: { id: string }) => x.id === t.id)).toMatchObject({
      inside: true,
      admits_used: 1,
      status: "used_up",
    });
    // The device pull holds back rows younger than the horizon, so a claim in the same second
    // as a page can never fall behind the phone's cursor.
    const c = await w.makeTicket(0);
    await w.pull();
    await w.hubClaim(a, w.scanBody(a, c.id));
    const sameSecond = await deviceSync(b.token, after.json.next_cursor);
    expect(sameSecond.json.tickets.find((x: { id: string }) => x.id === c.id)).toBeUndefined();
    env.clock.now += 2;
    const later = await deviceSync(b.token, after.json.next_cursor);
    expect(later.json.tickets.find((x: { id: string }) => x.id === c.id)).toMatchObject({
      inside: true,
    });
  });

  it("with the uplink cut the hub keeps admitting and exiting; when it returns every scan uploads exactly once and both sides agree", async () => {
    const dev = await w.enrolAtHub("Gate A", "both");
    const made = await Promise.all(
      [0, 0, 0, 1, 1, 2].map((type, i) => w.makeTicket(type, `Cut ${i}`)),
    );
    await w.pull();
    await w.push();

    w.cutUplink();
    // One scan per second, as at a gate: the sync orders a ticket's scans by `scanned_at`.
    for (const t of made) {
      env.clock.now += 1;
      expect((await w.hubClaim(dev, w.scanBody(dev, t.id))).json.result).toBe("admitted");
    }
    // Exits and re-entries on the re-entry types, still with no VM.
    for (const t of made.slice(3)) {
      env.clock.now += 1;
      expect((await w.hubExit(dev, w.scanBody(dev, t.id))).json.result).toBe("exited");
      env.clock.now += 1;
      expect((await w.hubClaim(dev, w.scanBody(dev, t.id))).json.result).toBe("admitted");
    }
    await expect(w.push()).rejects.toBeInstanceOf(VmUnreachable);
    await expect(w.pull()).rejects.toBeInstanceOf(VmUnreachable);
    expect(getState(w.hub, "last_cloud_error")).toBeTruthy();
    const pending = pendingScanCount(w.hub);
    expect(pending).toBeGreaterThanOrEqual(6 + 3 * 2);
    expect(await vmScans(made[0]!.id)).toHaveLength(0); // the VM has heard nothing

    w.restoreUplink();
    expect((await w.push()).scans).toBe(pending);
    expect(pendingScanCount(w.hub)).toBe(0);
    expect((await w.push()).scans).toBe(0); // nothing left; a second upload is a no-op

    for (const t of made) {
      const hubSide = hubRow(t.id)!;
      const vmSide = (await vmRow(t.id))!;
      expect({ used: vmSide.admitsUsed, inside: vmSide.inside, status: vmSide.status }).toEqual({
        used: hubSide.admitsUsed,
        inside: hubSide.inside,
        status: hubSide.status,
      });
      const ids = (await vmScans(t.id)).map((s) => s.id).sort();
      expect(ids).toEqual(
        hubScansOf(t.id)
          .map((s) => s.id)
          .sort(),
      );
      expect(new Set(ids).size).toBe(ids.length); // exactly once
    }
    // The VM's counts match the hub's: it recomputed from the uploaded scans.
    expect(await vmRow(made[3]!.id)).toMatchObject({ admitsUsed: 2, inside: true });
  });

  it("a phone enrolled at the hub with no VM reachable works at the hub, and its token works against the VM after the next sync", async () => {
    // The code is made on the VM and cached by the hub while the uplink is up ...
    const created = await call((await import("../src/app/api/devices/enroll/route")).POST, {
      staff: w.supervisor,
      body: { event_id: w.eventId, gate: "Gate B", direction: "entry", label: "offline phone" },
    });
    await w.pull();
    const t = await w.makeTicket(0, "Offline enrol");
    await w.pull();

    // ... and the phone enrols at the hub after the uplink dies.
    w.cutUplink();
    const { decodeSetupCode } = await import("@events-qr/core");
    const decoded = decodeSetupCode(created.json.setup_qr);
    if (!decoded.ok) throw new Error("bad qr");
    const id = randomUUID();
    const enrol = await call(hubRoutes.enroll, {
      body: { code: decoded.setup.code, device_id: id },
    });
    expect(enrol.status).toBe(200);
    expect(() => api.enrollExchangeResponse.parse(enrol.json)).not.toThrow();
    expect(enrol.json.key_bundle.cloud_url).toBe("http://vm.test");
    const phone = { id, token: enrol.json.device_token as string };
    // The code cannot be used twice at the hub.
    expect(
      (
        await call(hubRoutes.enroll, {
          body: { code: decoded.setup.code, device_id: randomUUID() },
        })
      ).status,
    ).toBe(401);
    expect((await w.hubClaim(phone, w.scanBody(phone, t.id, { gate: "Gate B" }))).json.result).toBe(
      "admitted",
    );

    // The VM does not know this phone yet.
    const early = await call(vmClaim, { bearer: phone.token, body: w.scanBody(phone, t.id) });
    expect(early.status).toBe(401);

    w.restoreUplink();
    await w.push();
    const [dev] = await env.handle.db
      .select()
      .from(mysqlSchema.devices)
      .where(eq(mysqlSchema.devices.id, id));
    expect(dev).toMatchObject({
      gate: "Gate B",
      direction: "entry",
      kind: "scanner",
      label: "offline phone",
    });
    const [code] = await env.handle.db.select().from(mysqlSchema.enrolmentCodes);
    expect(code).toBeDefined();
    const second = await w.makeTicket(0, "Fallback to VM");
    const viaVm = await call(vmClaim, {
      bearer: phone.token,
      body: w.scanBody(phone, second.id, { gate: "Gate B" }),
    });
    expect(viaVm.json.result).toBe("admitted");
    // The scan it made at the hub is on the VM, attributed to the device.
    const uploaded = await vmScans(t.id);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.deviceId).toBe(id);
  });

  it("a code used at the VM stops working at the hub after the next pull", async () => {
    const vmPhone = await w.enrolAtVm("Gate A", "entry"); // used straight away at the VM
    expect(vmPhone.id).toBeTruthy();
    const created = await call((await import("../src/app/api/devices/enroll/route")).POST, {
      staff: w.supervisor,
      body: { event_id: w.eventId, gate: "Gate A", direction: "entry" },
    });
    await w.pull();
    const { decodeSetupCode } = await import("@events-qr/core");
    const decoded = decodeSetupCode(created.json.setup_qr);
    if (!decoded.ok) throw new Error("bad qr");
    // Used at the VM first (no hub involved) ...
    const used = await call((await import("../src/app/api/devices/enroll/route")).POST, {
      body: { code: decoded.setup.code, device_id: randomUUID() },
    });
    expect(used.status).toBe(200);
    await w.pull();
    // ... so the hub no longer accepts it.
    expect(
      (
        await call(hubRoutes.enroll, {
          body: { code: decoded.setup.code, device_id: randomUUID() },
        })
      ).status,
    ).toBe(401);
  });

  it("phones enrolled at the VM can use the hub after the hub pulls devices; a revocation reaches the hub", async () => {
    const phone = await w.enrolAtVm("Gate A", "entry");
    const t = await w.makeTicket(0);
    await w.pull();
    // Before the pull the hub did not know the device? It did (pulled just now): it is accepted.
    expect((await w.hubClaim(phone, w.scanBody(phone, t.id))).json.result).toBe("admitted");

    await env.handle.db
      .update(mysqlSchema.devices)
      .set({ revoked: true })
      .where(eq(mysqlSchema.devices.id, phone.id));
    await w.pull();
    const t2 = await w.makeTicket(0);
    await w.pull();
    expect((await w.hubClaim(phone, w.scanBody(phone, t2.id))).status).toBe(401);
  });

  it("staff log in at the hub with their PIN, mirrored from the VM", async () => {
    await w.pull();
    const ok = await call(hubRoutes.login, { body: { name: w.supervisor.name, pin: TEST_PIN } });
    expect(ok.json).toMatchObject({ id: w.supervisor.id, role: "supervisor" });
    const bad = await call(hubRoutes.login, {
      body: { name: w.supervisor.name, pin: "wrong-pin-1" },
    });
    expect(bad.status).toBe(401);
    // Same answer shape as the VM's login.
    const vm = await call(vmLogin, { body: { name: w.supervisor.name, pin: TEST_PIN } });
    expect(Object.keys(ok.json).sort()).toEqual(Object.keys(vm.json).sort());
  });

  describe("conflicts converge on both sides", () => {
    it("an admit at the VM and one at the hub for the same ticket: the later by scanned_at is flagged, on the VM and on the hub", async () => {
      const hubPhone = await w.enrolAtHub("Gate A", "entry");
      const vmPhone = await w.enrolAtVm("Gate B", "entry");
      const t = await w.makeTicket(0, "Twice");
      await w.pull();
      await w.push();

      w.cutUplink();
      const t1 = env.clock.now;
      const hubScan = w.scanBody(hubPhone, t.id, { scanned_at: t1 });
      expect((await w.hubClaim(hubPhone, hubScan)).json.result).toBe("admitted");
      // The phone could not reach the hub and fell back to the VM, which has not heard of the hub's admit.
      const vmScan = w.scanBody(vmPhone, t.id, { scanned_at: t1 + 30, gate: "Gate B" });
      expect((await call(vmClaim, { bearer: vmPhone.token, body: vmScan })).json.result).toBe(
        "admitted",
      );
      w.restoreUplink();

      await w.push(); // VM learns the hub's scan and recomputes
      await w.pull(); // hub learns the VM's scan and recomputes

      for (const side of ["vm", "hub"] as const) {
        const rows =
          side === "vm"
            ? (await vmScans(t.id)).map((s) => ({ id: s.id, conflict: s.conflict }))
            : hubScansOf(t.id).map((s) => ({ id: s.id, conflict: s.conflict }));
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.id === hubScan.scan_id)!.conflict).toBe(false); // earlier: canonical
        expect(rows.find((r) => r.id === vmScan.scan_id)!.conflict).toBe(true);
      }
      expect(await vmRow(t.id)).toMatchObject({ admitsUsed: 2, inside: true, status: "used_up" });
      expect(hubRow(t.id)).toMatchObject({ admitsUsed: 2, inside: true, status: "used_up" });
    });

    it("scans a phone uploads to the hub (POST /scans) are kept, flagged by order, idempotent, and reach the VM", async () => {
      const phone = await w.enrolAtHub("Gate A", "entry");
      const other = await w.enrolAtHub("Gate B", "entry");
      const t = await w.makeTicket(0, "Offline phone");
      await w.pull();
      const now = env.clock.now;
      const early = {
        scan_id: randomUUID(),
        ticket_id: t.id,
        device_id: phone.id,
        staff_id: null,
        gate: "Gate A",
        direction: "entry",
        scanned_at: now - 20,
        result: "admitted",
        offline: true,
      };
      // The hub admits the ticket live, later than the phone's offline scan happened.
      await w.hubClaim(other, w.scanBody(other, t.id, { scanned_at: now }));
      const up = await call(hubRoutes.scans, { bearer: phone.token, body: { scans: [early] } });
      expect(() => api.hubScansResponse.parse(up.json)).not.toThrow();
      expect(up.json.acknowledged).toEqual([early.scan_id]);
      // The earliest scanned_at is canonical: the live hub admit is now the later (conflicting) one.
      const rows = hubScansOf(t.id);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === early.scan_id)!.conflict).toBe(false);
      expect(rows.find((r) => r.id !== early.scan_id)!.conflict).toBe(true);
      expect(up.json.conflicts).toEqual([]); // the flagged one is the other row, not this upload

      const again = await call(hubRoutes.scans, { bearer: phone.token, body: { scans: [early] } });
      expect(again.json.acknowledged).toEqual([early.scan_id]);
      expect(hubScansOf(t.id)).toHaveLength(2);
      // Another device's id in the batch is refused.
      const stolen = await call(hubRoutes.scans, {
        bearer: other.token,
        body: { scans: [{ ...early, scan_id: randomUUID() }] },
      });
      expect(stolen.status).toBe(403);

      await w.push();
      const onVm = await vmScans(t.id);
      expect(onVm).toHaveLength(2);
      expect(onVm.filter((s) => s.conflict)).toHaveLength(1);
    });
  });

  it("health reports the last cloud sync and how many scans are waiting", async () => {
    await w.pull();
    const res = await call(hubRoutes.health);
    expect(() => api.healthResponse.parse(res.json)).not.toThrow();
    expect(res.json).toMatchObject({ ok: true, mode: "hub", last_cloud_sync_at: env.clock.now });
    expect(typeof res.json.pending_scans).toBe("number");
  });

  it("pulling is idempotent: a second pull changes nothing and never rewinds the hub's own admits", async () => {
    const dev = await w.enrolAtHub("Gate A", "entry");
    const t = await w.makeTicket(0);
    await w.pull();
    await w.hubClaim(dev, w.scanBody(dev, t.id));
    const before = hubRow(t.id)!;
    // Force the pull to see the (stale, unadmitted) VM row again.
    await w.hub.db.run(
      (await import("drizzle-orm")).sql`DELETE FROM hub_state WHERE key = 'cursor_tickets'`,
    );
    await w.pull();
    await w.pull();
    expect(hubRow(t.id)).toMatchObject({ admitsUsed: 1, inside: true, status: "used_up" });
    expect(hubRow(t.id)!.updatedAt).toBe(before.updatedAt);
    expect(vmClientFor(w.hub)).toBeDefined();
  });
});
