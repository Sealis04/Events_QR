/** M6 dashboard APIs against the VM and, with the uplink cut, against the hub. */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { GET as vmMe } from "../src/app/api/auth/me/route";
import { GET as vmStats } from "../src/app/api/events/[id]/stats/route";
import { GET as vmConflicts } from "../src/app/api/events/[id]/conflicts/route";
import { GET as vmDevices } from "../src/app/api/events/[id]/devices/route";
import { GET as vmTickets, POST as vmGenerate } from "../src/app/api/events/[id]/tickets/route";
import { GET as vmExport } from "../src/app/api/events/[id]/tickets/export/route";
import { POST as vmAdmit } from "../src/app/api/events/[id]/admit/route";
import { GET as vmOverrides } from "../src/app/api/events/[id]/overrides/route";
import { POST as vmReview } from "../src/app/api/scans/[id]/review/route";
import { PATCH as vmPatchDevice } from "../src/app/api/devices/[id]/route";
import { POST as vmHeartbeat } from "../src/app/api/devices/heartbeat/route";
import { GET as vmTicket } from "../src/app/api/tickets/[id]/route";
import { POST as vmScansUpload } from "../src/app/api/scans/route";
import { POST as vmClaim } from "../src/app/api/claim/route";
import * as hub from "../src/hub/dashboard";
import * as hubRoutes from "../src/hub/routes";
import { call, createTestEnv, dbAvailable, newKey, PRIVILEGED_PIN, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

const { scans: vmScansTable, tickets: vmTickets_ } = mysqlSchema;

describe.skipIf(!dbAvailable)("dashboard APIs", () => {
  let env: TestEnv;
  let w: HubWorld;
  let id: string;
  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    id = String(w.eventId);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  const params = () => ({ id });
  const vmScanRows = (ticket: string) =>
    env.handle.db
      .select()
      .from(vmScansTable)
      .where(eq(vmScansTable.ticketId, Buffer.from(hexToBytes(ticket))));

  describe("VM", () => {
    it("stats count admits per gate and type, who is inside, conflicts and scans per minute", async () => {
      const a = await w.enrolAtVm("Gate A", "both");
      const b = await w.enrolAtVm("Gate B", "entry");
      const single = await w.makeTicket(0, "S1");
      const unlimited = await w.makeTicket(2, "U1");
      const claim = (dev: typeof a, t: { id: string }, extra = {}) =>
        call(vmClaim, {
          bearer: dev.token,
          body: { ...w.scanBody(dev, t.id, { gate: "x" }), ...extra },
        });
      expect((await claim(a, single)).json.result).toBe("admitted");
      expect((await claim(b, unlimited)).json.result).toBe("admitted");
      expect((await claim(a, single)).json.result).toBe("rejected_inside"); // not counted

      const res = await call(vmStats, { staff: w.staff, params: params() });
      const stats = api.eventStatsResponse.parse(res.json);
      expect(stats.total_admitted).toBe(2);
      expect(stats.by_gate).toEqual({ "Gate A": 1, "Gate B": 1 });
      expect(stats.by_ticket_type).toEqual({ "0": 1, "2": 1 });
      expect(stats.inside).toBe(2);
      expect(stats.scans_per_minute.reduce((n, m) => n + m.count, 0)).toBe(2);
      expect(stats.scans_per_minute.every((m) => m.minute % 60 === 0)).toBe(true);
      // The line only covers the last 60 minutes.
      env.clock.now += 61 * 60;
      const later = api.eventStatsResponse.parse(
        (await call(vmStats, { staff: w.staff, params: params() })).json,
      );
      expect(later.scans_per_minute).toEqual([]);
      expect(later.total_admitted).toBe(2);
      env.clock.now -= 61 * 60;
    });

    it("the device panel carries heartbeat data, last scan, and highlights come from last_seen; supervisors can move a phone", async () => {
      const phone = await w.enrolAtVm("Gate A", "entry");
      const hb = await call(vmHeartbeat, {
        bearer: phone.token,
        body: { outbox_size: 7, battery_pct: 63 },
      });
      expect(hb.status).toBe(200);
      expect(
        (await call(vmHeartbeat, { bearer: phone.token, body: { outbox_size: -1 } })).status,
      ).toBe(400);
      expect((await call(vmHeartbeat, { body: { outbox_size: 1 } })).status).toBe(401);

      const t = await w.makeTicket(0, "Panel");
      await call(vmClaim, { bearer: phone.token, body: w.scanBody(phone, t.id) });

      expect((await call(vmDevices, { staff: w.staff, params: params() })).status).toBe(403);
      const panel = api.devicePanelResponse.parse(
        (await call(vmDevices, { staff: w.supervisor, params: params() })).json,
      );
      const mine = panel.devices.find((d) => d.id === phone.id)!;
      expect(mine).toMatchObject({
        outbox_size: 7,
        battery_pct: 63,
        gate: "Gate A",
        direction: "entry",
        revoked: false,
        kind: "scanner",
      });
      expect(mine.last_seen_at).not.toBeNull();
      expect(mine.last_scan_at).toBe(env.clock.now);
      expect(panel.server_time).toBe(env.clock.now);

      const moved = await call(vmPatchDevice, {
        method: "PATCH",
        params: { id: phone.id },
        staff: w.supervisor,
        body: { gate: "Gate B", direction: "both", label: "Left door" },
      });
      expect(moved.status).toBe(200);
      const bad = await call(vmPatchDevice, {
        method: "PATCH",
        params: { id: phone.id },
        staff: w.supervisor,
        body: { gate: "Nowhere" },
      });
      expect(bad.status).toBe(400);
      expect(
        (
          await call(vmPatchDevice, {
            method: "PATCH",
            params: { id: phone.id },
            staff: w.staff,
            body: { gate: "Gate A" },
          })
        ).status,
      ).toBe(403);
      const after = api.devicePanelResponse.parse(
        (await call(vmDevices, { staff: w.supervisor, params: params() })).json,
      );
      expect(after.devices.find((d) => d.id === phone.id)).toMatchObject({
        gate: "Gate B",
        direction: "both",
        label: "Left door",
      });
    });

    it("conflicts show both scans side by side and can be marked reviewed", async () => {
      const first = await w.enrolAtVm("Gate A", "entry");
      const second = await w.enrolAtVm("Gate B", "entry");
      const t = await w.makeTicket(0, "Double");
      const now = env.clock.now;
      const rec = (dev: typeof first, gate: string, at: number, scanId = randomUUID()) => ({
        scan_id: scanId,
        ticket_id: t.id,
        device_id: dev.id,
        staff_id: w.staff.id,
        gate,
        direction: "entry",
        scanned_at: at,
        result: "admitted",
        offline: true,
      });
      const early = rec(first, "Gate A", now - 30);
      const late = rec(second, "Gate B", now - 10);
      await call(vmScansUpload, { bearer: first.token, body: { scans: [early] } });
      const up = await call(vmScansUpload, { bearer: second.token, body: { scans: [late] } });
      expect(up.json.conflicts).toEqual([late.scan_id]);

      const feed = api.conflictsResponse.parse(
        (await call(vmConflicts, { staff: w.supervisor, params: params() })).json,
      );
      const item = feed.conflicts.find((c) => c.scan_id === late.scan_id)!;
      expect(item).toMatchObject({
        gate: "Gate B",
        offline: true,
        staff_name: w.staff.name,
        reviewed_at: null,
        canonical_detail: { gate: "Gate A", offline: true, staff_name: w.staff.name },
      });
      expect(item.device_id).toBe(second.id);
      expect(feed.total).toBeGreaterThanOrEqual(1);
      expect((await call(vmConflicts, { staff: w.staff, params: params() })).status).toBe(403);

      const review = (scanId: string, staff = w.supervisor, reviewed = true) =>
        call(vmReview, { params: { id: scanId }, staff, body: { reviewed } });
      expect((await review(late.scan_id, w.staff)).status).toBe(403);
      expect((await review(early.scan_id)).status).toBe(404); // not a conflict
      expect((await review(late.scan_id)).status).toBe(200);
      const reviewed = api.conflictsResponse.parse(
        (await call(vmConflicts, { staff: w.supervisor, params: params() })).json,
      );
      expect(reviewed.conflicts.find((c) => c.scan_id === late.scan_id)!.reviewed_at).toBe(
        env.clock.now,
      );
      expect((await review(late.scan_id, w.supervisor, false)).status).toBe(200);
      const undone = api.conflictsResponse.parse(
        (await call(vmConflicts, { staff: w.supervisor, params: params() })).json,
      );
      expect(undone.conflicts.find((c) => c.scan_id === late.scan_id)!.reviewed_at).toBeNull();
    });

    it("attendee search by name, email or last 6 hex; status filter; CSV export; ticket detail with QR", async () => {
      const gen = await call(vmGenerate, {
        staff: w.staff,
        params: params(),
        body: {
          idempotency_key: newKey(),
          ticket_type: 0,
          holder_name: "Zelda Searchable",
          holder_email: "zelda@find.me",
          holder_phone: "+63 917 000 1111",
        },
      });
      const tid = gen.json.tickets[0].ticket_id as string;
      const short = gen.json.tickets[0].short_id as string;
      const find = async (q: string, extra: Record<string, string> = {}) =>
        (await call(vmTickets, { staff: w.staff, params: params(), query: { q, ...extra } })).json;
      expect(
        (await find("Searchable")).tickets.map((t: { ticket_id: string }) => t.ticket_id),
      ).toEqual([tid]);
      expect((await find("find.me")).tickets).toHaveLength(1);
      expect((await find("917 000")).tickets).toHaveLength(1);
      expect((await find(short)).tickets.map((t: { ticket_id: string }) => t.ticket_id)).toContain(
        tid,
      );
      expect((await find(short.toLowerCase())).tickets.length).toBeGreaterThan(0);
      expect((await find("Searchable", { status: "cancelled" })).tickets).toHaveLength(0);
      expect((await find("nobody-like-this")).total).toBe(0);

      expect((await call(vmExport, { staff: w.staff, params: params() })).status).toBe(403);
      const csv = await call(vmExport, { staff: w.admin, params: params() });
      expect(csv.headers.get("content-type")).toContain("text/csv");
      expect(csv.text.split("\r\n")[0]).toContain("ticket_id,short_id,holder_name,holder_email");
      expect(csv.text).toContain("Zelda Searchable,zelda@find.me,+63 917 000 1111,Single,valid");

      const detail = await call(vmTicket, { staff: w.staff, params: { id: tid } });
      expect(detail.status).toBe(200);
      expect(detail.json).toMatchObject({
        event_name: "Summer Fest",
        type_name: "Single",
        short_id: short,
        holder_name: "Zelda Searchable",
      });
      expect(detail.json.qr_png).toMatch(/^data:image\/png;base64,/);
    });

    it("manual admit needs a supervisor and their PIN again, is logged as an override, and audited by staff", async () => {
      const t = await w.makeTicket(0, "Manual");
      const admit = (staff = w.supervisor, pin = PRIVILEGED_PIN, ticket = t.id) =>
        call(vmAdmit, { params: params(), staff, body: { ticket_id: ticket, pin } });
      expect((await admit(w.staff)).status).toBe(403);
      expect((await admit(w.supervisor, "00000000")).status).toBe(401);
      expect((await admit(w.supervisor, PRIVILEGED_PIN, "00".repeat(16))).status).toBe(404);
      const ok = await admit();
      expect(ok.json).toMatchObject({ result: "admitted", admits_used: 1 });
      expect((await admit()).json.result).toBe("rejected_inside");
      const rows = await vmScanRows(t.id);
      const over = rows.find((r) => r.result === "override")!;
      expect(over).toMatchObject({ staffId: w.supervisor.id, deviceId: null, gate: "Dashboard" });

      const audit = api.overridesResponse.parse(
        (await call(vmOverrides, { staff: w.supervisor, params: params() })).json,
      );
      expect(audit.overrides.find((o) => o.scan_id === over.id)).toMatchObject({
        staff_name: w.supervisor.name,
        holder_name: "Manual",
      });
      expect(audit.by_staff.find((s) => s.staff_id === w.supervisor.id)!.count).toBeGreaterThan(0);
      expect((await call(vmOverrides, { staff: w.staff, params: params() })).status).toBe(403);
      const [row] = await env.handle.db
        .select()
        .from(vmTickets_)
        .where(eq(vmTickets_.id, Buffer.from(hexToBytes(t.id))));
      expect(row).toMatchObject({ inside: true, admitsUsed: 1 });
    });

    it("the VM reports its mode on /auth/me", async () => {
      const res = await call(vmMe, { staff: w.supervisor });
      expect(res.json).toMatchObject({ role: "supervisor", mode: "server", pin_reset: null });
    });
  });
});

describe.skipIf(!dbAvailable)("dashboard on the hub, VM unreachable", () => {
  let env: TestEnv;
  let w: HubWorld;
  let sup: { cookie: string };

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    await w.pull();
    const res = await call(hubRoutes.login, {
      body: { name: w.supervisor.name, pin: PRIVILEGED_PIN },
    });
    sup = { cookie: res.headers.get("set-cookie")!.split(";")[0]! };
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  /** The hub handlers read the event id from the request path, so they get real paths. */
  const req = async (
    handler: (req: Request) => Promise<Response>,
    path: string,
    init: { method?: string; cookie?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = {};
    if (init.cookie) headers.cookie = init.cookie;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const res = await handler(
      new Request(`http://hub.test/api/events/${w.eventId}${path}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  it("supervisors and admins get a dashboard session from the hub's own staff list; plain staff and wrong PINs do not", async () => {
    const login = (name: string, pin: string, extra = {}) =>
      call(hubRoutes.login, { body: { name, pin, ...extra } });
    const admin = await login(w.admin.name, PRIVILEGED_PIN);
    expect(admin.status).toBe(200);
    expect(admin.headers.get("set-cookie")).toContain("HttpOnly");
    const plain = await login(w.staff.name, "correct-horse");
    expect(plain.status).toBe(200); // fine for a phone...
    expect(plain.headers.get("set-cookie")).toBeNull(); // ...but no dashboard session
    const phone = await login(w.supervisor.name, PRIVILEGED_PIN, { for: "scanner" });
    expect(phone.headers.get("set-cookie")).toBeNull();
    expect((await login(w.supervisor.name, "11111111")).status).toBe(401);

    expect((await call(hub.me, {})).status).toBe(401);
    expect((await call(hub.me, { staff: sup })).json).toMatchObject({
      role: "supervisor",
      mode: "hub",
      pin_reset: null,
    });
    expect((await call(hub.logout, { staff: sup, body: {} })).headers.get("set-cookie")).toContain(
      "Max-Age=0",
    );
  });

  it("event, stats, device panel, search and conflicts come from SQLite and match the VM after the uplink returns", async () => {
    const phone = await w.enrolAtHub("Gate A", "entry");
    const other = await w.enrolAtHub("Gate B", "entry");
    const t = await w.makeTicket(1, "Hub Hana");
    const u = await w.makeTicket(0, "Hub Hugo");
    await w.pull();
    w.cutUplink();
    expect((await w.hubClaim(phone, w.scanBody(phone, t.id, { gate: "x" }))).json.result).toBe(
      "admitted",
    );
    expect((await w.hubClaim(other, w.scanBody(other, u.id))).json.result).toBe("admitted");

    expect((await req(hub.stats, "/stats")).status).toBe(401); // no session, no data

    expect((await call(hub.eventList, { staff: sup })).json[0]).toMatchObject({ id: w.eventId });
    const view = await req(hub.eventView, "", { cookie: sup.cookie });
    expect(view.json).toMatchObject({ id: w.eventId, name: "Summer Fest" });
    expect(view.json.ticket_types.map((x: { name: string }) => x.name)).toEqual([
      "Single",
      "Limited",
      "Unlimited",
    ]);
    expect((await req(hub.eventView, "", { cookie: sup.cookie })).status).toBe(200);
    const wrongEvent = await hub.eventView(
      new Request("http://hub.test/api/events/9999", { headers: { cookie: sup.cookie } }),
    );
    expect(wrongEvent.status).toBe(404);

    const stats = api.eventStatsResponse.parse(
      (await req(hub.stats, "/stats", { cookie: sup.cookie })).json,
    );
    expect(stats).toMatchObject({
      total_admitted: 2,
      inside: 2,
      by_gate: { "Gate A": 1, "Gate B": 1 },
    });
    expect(stats.by_ticket_type).toEqual({ "0": 1, "1": 1 });
    expect(stats.scans_per_minute.reduce((n, m) => n + m.count, 0)).toBe(2);

    const hb = await call(hub.heartbeat, {
      bearer: phone.token,
      body: { outbox_size: 3, battery_pct: 40 },
    });
    expect(hb.status).toBe(200);
    const panel = api.devicePanelResponse.parse(
      (await req(hub.devices, "/devices", { cookie: sup.cookie })).json,
    );
    expect(panel.devices.find((d) => d.id === phone.id)).toMatchObject({
      outbox_size: 3,
      battery_pct: 40,
      last_scan_at: env.clock.now,
    });

    const byName = await req(hub.ticketList, "/tickets?q=Hana", { cookie: sup.cookie });
    expect(byName.json.tickets.map((x: { ticket_id: string }) => x.ticket_id)).toEqual([t.id]);
    const byHex = await req(hub.ticketList, `/tickets?q=${t.id.slice(-6)}`, { cookie: sup.cookie });
    expect(byHex.json.tickets.map((x: { ticket_id: string }) => x.ticket_id)).toContain(t.id);

    // Both sides agree once the hub's scans reach the VM.
    w.restoreUplink();
    await w.push();
    const vm = api.eventStatsResponse.parse(
      (await call(vmStats, { staff: w.supervisor, params: { id: String(w.eventId) } })).json,
    );
    expect(vm).toMatchObject({ by_gate: stats.by_gate, total_admitted: 2, inside: 2 });
  });

  it("the conflict feed shows both scans; reviewing is VM-only", async () => {
    const phone = await w.enrolAtHub("Gate A", "entry");
    const other = await w.enrolAtHub("Gate B", "entry");
    const t = await w.makeTicket(0, "Hub Double");
    await w.pull();
    const now = env.clock.now;
    await w.hubClaim(other, w.scanBody(other, t.id, { scanned_at: now }));
    await call(hubRoutes.scans, {
      bearer: phone.token,
      body: {
        scans: [
          {
            scan_id: randomUUID(),
            ticket_id: t.id,
            device_id: phone.id,
            staff_id: w.staff.id,
            gate: "Gate A",
            direction: "entry",
            scanned_at: now - 20,
            result: "admitted",
            offline: true,
          },
        ],
      },
    });
    const feed = api.conflictsResponse.parse(
      (await req(hub.conflicts, "/conflicts", { cookie: sup.cookie })).json,
    );
    const item = feed.conflicts.find((c) => c.ticket_id === t.id)!;
    expect(item).toMatchObject({
      gate: "Gate B",
      offline: false,
      canonical_detail: { gate: "Gate A", offline: true },
    });
    expect(item.canonical_detail!.staff_name).toBe(w.staff.name);

    process.env.APP_MODE = "hub";
    try {
      const res = await call(vmReview, {
        params: { id: item.scan_id },
        staff: w.supervisor,
        body: {},
      });
      expect(res.status).toBe(404);
      expect(
        (await call(vmGenerate, { staff: w.staff, params: { id: String(w.eventId) }, body: {} }))
          .status,
      ).toBe(404);
    } finally {
      delete process.env.APP_MODE;
    }
  });

  it("manual admit on the hub: needs the supervisor's PIN, is logged as an override, and reaches the VM later", async () => {
    const t = await w.makeTicket(0, "Hub Manual");
    await w.pull();
    w.cutUplink();
    const admit = (cookie: string | undefined, pin: string, ticket = t.id) =>
      req(hub.admit, "/admit", { cookie, body: { ticket_id: ticket, pin } });

    expect((await admit(undefined, PRIVILEGED_PIN)).status).toBe(401);
    expect((await admit(sup.cookie, "00000000")).status).toBe(401);
    expect((await admit(sup.cookie, PRIVILEGED_PIN, "00".repeat(16))).status).toBe(404);
    const ok = await admit(sup.cookie, PRIVILEGED_PIN);
    expect(ok.json).toMatchObject({ result: "admitted", admits_used: 1 });
    expect((await admit(sup.cookie, PRIVILEGED_PIN)).json.result).toBe("rejected_inside");

    const hubScans = w.hub.db
      .select()
      .from(sqliteSchema.scans)
      .where(eq(sqliteSchema.scans.ticketId, hexToBytes(t.id)))
      .all();
    const over = hubScans.find((s) => s.result === "override")!;
    expect(over).toMatchObject({ staffId: w.supervisor.id, gate: "Dashboard", offline: false });

    const audit = api.overridesResponse.parse(
      (await req(hub.overrides, "/overrides", { cookie: sup.cookie })).json,
    );
    expect(audit.overrides.find((o) => o.scan_id === over.id)).toMatchObject({
      staff_name: w.supervisor.name,
      holder_name: "Hub Manual",
    });

    w.restoreUplink();
    await w.push();
    const onVm = await vmScanRows(t.id);
    expect(onVm.find((s) => s.result === "override")).toMatchObject({
      staffId: w.supervisor.id,
      deviceId: over.deviceId,
    });
    const row = (
      await env.handle.db
        .select()
        .from(vmTickets_)
        .where(eq(vmTickets_.id, Buffer.from(hexToBytes(t.id))))
    )[0]!;
    expect(row).toMatchObject({ inside: true, admitsUsed: 1 });
  });

  function vmScanRows(ticket: string) {
    return env.handle.db
      .select()
      .from(vmScansTable)
      .where(eq(vmScansTable.ticketId, Buffer.from(hexToBytes(ticket))));
  }
});
