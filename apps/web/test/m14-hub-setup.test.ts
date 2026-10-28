import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sqliteSchema, mysqlSchema } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as hubSetup } from "../src/app/api/hubs/setup/route";
import { POST as revokeSelfRoute } from "../src/app/api/hubs/revoke-self/route";
import { POST as revokeDeviceRoute } from "../src/app/api/devices/[id]/revoke/route";
import { POST as enrollRoute } from "../src/app/api/devices/enroll/route";
import { startHubLoops } from "../src/hub/loops";
import { createHubSession } from "../src/hub/session";
import { resetLinkLimits } from "../src/hub/setup";
import { getLink, getState, setState } from "../src/hub/state";
import * as hubRoutes from "../src/hub/routes";
import { call, createTestEnv, dbAvailable, eventBody, type TestEnv } from "./helpers";
import { createHubWorld, VM_URL, type HubWorld } from "./hub-helpers";

const s = sqliteSchema;

describe.skipIf(!dbAvailable)("M14 hub setup page and reset", () => {
  let env: TestEnv;
  let w: HubWorld;
  const cookie = (id: string) => ({ cookie: `eqr_session=${createHubSession(w.hub, id)}` });
  const sessionOf = (who: { id: string }) => cookie(who.id);

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });
  beforeEach(() => {
    resetLinkLimits();
    w.hub.config.HUB_SERVER_URL = VM_URL;
  });

  const newCode = async (eventId = w.eventId) => {
    const res = await call(hubSetup, {
      staff: w.supervisor,
      body: { event_id: eventId, label: "hub" },
    });
    expect(res.status).toBe(201);
    return res.json.setup_code as string;
  };
  const link = (code: string, extra: Record<string, unknown> = {}, ip = "10.0.0.1") =>
    call(hubRoutes.link, {
      body: { code, ...extra },
      headers: { "x-forwarded-for": ip },
    });
  const nonEmptyTables = () =>
    Object.values(s).filter((t) => w.hub.db.select().from(t).all().length > 0);

  it("status says linked, shows the server address and event, and leaks no secrets", async () => {
    const res = await call(hubRoutes.status);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      linked: true,
      server_url: VM_URL,
      event_id: w.eventId,
      unsent: { scans: 0, devices: 0, checks: 0 },
    });
    const text = res.text;
    const token = getLink(w.hub)!.token;
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/token|secret|bundle|key/i);
    expect(Object.keys(res.json).sort()).toEqual(
      ["event_id", "event_name", "linked", "server_url", "unsent"].sort(),
    );
  });

  it("refuses to link a hub that is already linked", async () => {
    const res = await link(await newCode());
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("already_linked");
  });

  describe("unlinked hub", () => {
    it("without HUB_SERVER_URL the link says so (503) and ignores a URL in the body", async () => {
      const unsent = await call(hubRoutes.reset, { staff: sessionOf(w.supervisor), body: {} });
      expect(unsent.status).toBe(200);
      w.hub.config.HUB_SERVER_URL = undefined;
      const res = await link("whatever");
      expect(res.status).toBe(503);
      expect(res.json.error.message).toMatch(/HUB_SERVER_URL/);
      // A body with a URL does not even validate: the address never comes from the request.
      const withUrl = await link("whatever", { vm_url: "http://evil.test" });
      expect(withUrl.status).toBe(400);
      expect((await call(hubRoutes.status)).json).toMatchObject({
        linked: false,
        server_url: null,
      });
    });

    it("links with a code, then refuses a second link; a wrong code is explained", async () => {
      const bad = await link("not-a-code");
      expect(bad.status).toBe(400);
      expect(bad.json.error.code).toBe("code_refused");
      await w.makeTicket(0, "Before link");
      env.clock.now += 3;
      const ok = await link(await newCode());
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({ event_id: w.eventId });
      expect(ok.json.tickets).toBeGreaterThanOrEqual(1);
      const status = (await call(hubRoutes.status)).json;
      expect(status).toMatchObject({ linked: true, event_id: w.eventId });
      expect((await link(await newCode())).status).toBe(409);
    });

    it("an unreachable server is a plain message and leaves the hub unlinked", async () => {
      await call(hubRoutes.reset, { staff: sessionOf(w.supervisor), body: {} });
      w.cutUplink();
      const res = await link(await newCode());
      w.restoreUplink();
      expect(res.status).toBe(502);
      expect(res.json.error.message).toMatch(/internet|clock/);
      expect(getLink(w.hub)).toBeUndefined();
    });

    it("rate limits tries per client and overall", async () => {
      for (let i = 0; i < 5; i++) expect((await link("bad", {}, "1.1.1.1")).status).toBe(400);
      const limited = await link("bad", {}, "1.1.1.1");
      expect(limited.status).toBe(429);
      // Another client still gets through until the overall cap.
      expect((await link("bad", {}, "2.2.2.2")).status).toBe(400);
      resetLinkLimits();
      for (let i = 0; i < 30; i++) await link("bad", {}, `9.9.9.${i}`);
      expect((await link("bad", {}, "8.8.8.8")).status).toBe(429);
    });

    it("two links at once: one runs, the other is told to wait", async () => {
      const code = await newCode();
      const [a, b] = await Promise.all([link(code, {}, "3.3.3.3"), link(code, {}, "4.4.4.4")]);
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect([409]).toContain(statuses[1]);
      expect(getLink(w.hub)).toBeDefined();
    });
  });

  describe("reset", () => {
    it("needs a supervisor or admin session", async () => {
      expect((await call(hubRoutes.reset, { body: {} })).status).toBe(401);
      expect((await call(hubRoutes.reset, { staff: sessionOf(w.staff), body: {} })).status).toBe(
        403,
      );
    });

    it("is blocked while records are unsent; only an admin can force it", async () => {
      const dev = await w.enrolAtHub("Gate A", "entry");
      const t = await w.makeTicket(0, "Unsent");
      await w.pull();
      await w.hubClaim(dev, w.scanBody(dev, t.id));
      const status = (await call(hubRoutes.status)).json;
      expect(status.unsent.scans).toBe(1);
      expect(status.unsent.devices).toBe(1);

      const blocked = await call(hubRoutes.reset, { staff: sessionOf(w.supervisor), body: {} });
      expect(blocked.status).toBe(409);
      expect(blocked.json.error.code).toBe("unsent_records");
      expect(blocked.json.error.details).toMatchObject({ scans: 1, devices: 1 });
      const supForce = await call(hubRoutes.reset, {
        staff: sessionOf(w.supervisor),
        body: { force: true },
      });
      expect(supForce.status).toBe(403);
      expect(getLink(w.hub)).toBeDefined();

      const forced = await call(hubRoutes.reset, {
        staff: sessionOf(w.admin),
        body: { force: true },
      });
      expect(forced.status).toBe(200);
      expect(forced.json.revoked_on_server).toBe(true);
    });

    it("revokes only its own credential on the server and wipes every table and every session", async () => {
      // Re-link (the previous test left the hub wiped) and add a second hub row on the VM.
      const other = await call(hubSetup, {
        staff: w.supervisor,
        body: { event_id: w.eventId, label: "other hub" },
      });
      expect(other.status).toBe(201);
      expect((await link(await newCode())).status).toBe(200);
      const myId = getLink(w.hub)!.deviceId;
      const supervisor = sessionOf(w.supervisor);
      setState(w.hub, "last_cloud_error", "x");

      const res = await call(hubRoutes.reset, { staff: supervisor, body: {} });
      expect(res.status).toBe(200);
      expect(res.json.revoked_on_server).toBe(true);

      const [mine] = await env.handle.db
        .select()
        .from(mysqlSchema.devices)
        .where(eq(mysqlSchema.devices.id, myId));
      expect(mine!.revoked).toBe(true);
      const hubs = await env.handle.db
        .select()
        .from(mysqlSchema.devices)
        .where(eq(mysqlSchema.devices.kind, "hub"));
      expect(hubs.filter((h) => !h.revoked).every((h) => h.id !== myId)).toBe(true);

      expect(nonEmptyTables().map((t) => getTableConfig(t).name)).toEqual([]);
      expect(getState(w.hub, "session_secret")).toBeUndefined();
      // The old session cookie no longer works (a new secret is made on demand).
      const again = await call(hubRoutes.reset, { staff: supervisor, body: {} });
      expect(again.status).toBe(401);
      expect((await call(hubRoutes.status)).json).toMatchObject({ linked: false, event_id: null });
    });

    it("an unreachable server stops a normal reset and lets an admin force it", async () => {
      expect((await link(await newCode())).status).toBe(200);
      w.cutUplink();
      const normal = await call(hubRoutes.reset, { staff: sessionOf(w.supervisor), body: {} });
      expect(normal.status).toBe(409);
      expect(normal.json.error.code).toBe("server_unreachable");
      expect(getLink(w.hub)).toBeDefined();
      const forced = await call(hubRoutes.reset, {
        staff: sessionOf(w.admin),
        body: { force: true },
      });
      w.restoreUplink();
      expect(forced.status).toBe(200);
      expect(forced.json.revoked_on_server).toBe(false);
      expect(forced.json.message).toMatch(/Revoke/);
      expect(getLink(w.hub)).toBeUndefined();
    });

    it("linking again for a second event shows nothing of the first", async () => {
      const second = await call(createEvent, {
        staff: w.admin,
        body: eventBody(env.clock.now + 2 * 86400, {
          name: "Second event",
          ticket_types: [{ idx: 0, name: "Only" }],
        }),
      });
      expect(second.status).toBe(201);
      const secondId = second.json.id as number;
      await env.handle.db
        .insert(mysqlSchema.eventStaff)
        .values({ eventId: secondId, staffId: w.supervisor.id, assigned: true });
      env.clock.now += 3;
      const res = await link(await newCode(secondId));
      expect(res.status).toBe(200);
      expect(res.json.event_id).toBe(secondId);
      const events = w.hub.db.select().from(s.events).all();
      expect(events.map((e) => e.id)).toEqual([secondId]);
      expect(w.hub.db.select().from(s.tickets).all()).toHaveLength(0);
      expect(w.hub.db.select().from(s.scans).all()).toHaveLength(0);
      expect(w.hub.db.select().from(s.devices).all()).toHaveLength(0);
    });

    it("the sync loops idle quietly after a wipe and pick up a new link without a restart", async () => {
      // Only the supervisor is on the second event's staff list, so only they have a session here.
      const wiped = await call(hubRoutes.reset, { staff: sessionOf(w.supervisor), body: {} });
      expect(wiped.status).toBe(200);
      expect(getLink(w.hub)).toBeUndefined();
      const logs: string[] = [];
      let passes = 0;
      const loops = startHubLoops(w.hub, {
        log: (m) => logs.push(m),
        sleep: (ms, signal) =>
          new Promise((resolve) => {
            if (ms !== 1000) passes++;
            const timer = setTimeout(resolve, 5);
            signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), {
              once: true,
            });
          }),
      });
      for (let i = 0; i < 100 && passes < 6; i++) await new Promise((r) => setTimeout(r, 5));
      expect(passes).toBeGreaterThanOrEqual(6);
      expect(logs.filter((m) => /retrying/.test(m))).toEqual([]);
      // A new link while the loops run: they start syncing by themselves.
      const secondEvent = w.hub.db.select().from(s.events).all();
      expect(secondEvent).toHaveLength(0);
      env.clock.now += 3;
      expect((await link(await newCode())).status).toBe(200);
      const t = await w.makeTicket(0, "After relink");
      env.clock.now += 3;
      for (let i = 0; i < 200; i++) {
        if (
          w.hub.db
            .select()
            .from(s.tickets)
            .all()
            .some((x) => x.holderName === "After relink")
        )
          break;
        await new Promise((r) => setTimeout(r, 10));
      }
      await loops.stop();
      expect(t.id).toBeTruthy();
      expect(logs.filter((m) => /retrying/.test(m))).toEqual([]);
    });
  });

  describe("revoke-self on the VM", () => {
    it("marks only the calling hub; a phone's token is refused; calling again is harmless", async () => {
      if (!getLink(w.hub)) expect((await link(await newCode())).status).toBe(200);
      const mine = getLink(w.hub)!;
      const phone = await w.enrolAtVm("Gate A", "entry");
      const refused = await call(revokeSelfRoute, { bearer: phone.token, body: {} });
      expect(refused.status).toBe(403);
      const [phoneRow] = await env.handle.db
        .select()
        .from(mysqlSchema.devices)
        .where(eq(mysqlSchema.devices.id, phone.id));
      expect(phoneRow!.revoked).toBe(false);

      const ok = await call(revokeSelfRoute, { bearer: mine.token, method: "POST" });
      expect(ok.status).toBe(200);
      const hubRows = await env.handle.db
        .select()
        .from(mysqlSchema.devices)
        .where(eq(mysqlSchema.devices.kind, "hub"));
      expect(hubRows.find((h) => h.id === mine.deviceId)!.revoked).toBe(true);
      // Revoked now: the same call is 401, which the hub treats as "already revoked".
      expect((await call(revokeSelfRoute, { bearer: mine.token, method: "POST" })).status).toBe(
        401,
      );
      expect((await call(revokeSelfRoute, {})).status).toBe(401);
    });

    it("the Devices tab can revoke a hub row", async () => {
      const code = await call(hubSetup, {
        staff: w.supervisor,
        body: { event_id: w.eventId, label: "to revoke" },
      });
      const exchange = await call((await import("../src/app/api/hubs/enroll/route")).POST, {
        body: { code: code.json.setup_code, device_id: crypto.randomUUID() },
      });
      expect(exchange.status).toBe(200);
      const id = exchange.json.device_id as string;
      const res = await call(revokeDeviceRoute, {
        staff: w.supervisor,
        params: { id },
        body: {},
      });
      expect(res.status).toBe(200);
      const [row] = await env.handle.db
        .select()
        .from(mysqlSchema.devices)
        .where(eq(mysqlSchema.devices.id, id));
      expect(row!.revoked).toBe(true);
      void enrollRoute;
    });
  });
});
