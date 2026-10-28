import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, mysqlSchema, sqliteSchema, type DnsLookup } from "@events-qr/core";
import { GET as vmView } from "../src/app/api/events/[id]/hub-setup/route";
import { POST as vmRun } from "../src/app/api/events/[id]/hub-setup/checks/route";
import { POST as syncHubChecks } from "../src/app/api/sync/hub-checks/route";
import { GET as syncCounts } from "../src/app/api/sync/counts/route";
import { hubRunCheckRoute, hubSetupViewRoute } from "../src/hub/hubSetup";
import { createHubSession } from "../src/hub/session";
import { getLink, getState, setState } from "../src/hub/state";
import { uplinkOutages } from "../src/hub/vmsync";
import { SESSION_COOKIE } from "../src/server/auth";
import {
  parseDnsAnswers,
  parseHubAddress,
  publicDnsLookup,
  tlsProbe,
} from "../src/server/hubProbe";
import { runHubCheck, type HubProbes } from "../src/server/hubSetup";
import { call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

const { hubChecks, devices } = mysqlSchema;
const hubSide = sqliteSchema;

const fixedProbes = (over: Partial<HubProbes> = {}): HubProbes => ({
  dns: async (host): Promise<DnsLookup> => ({ host, addresses: ["192.168.50.10"] }),
  tls: async () => undefined,
  ...over,
});

describe("hub address parsing and the DNS test hook", () => {
  it("accepts names, urls and ports", () => {
    expect(parseHubAddress("hub.example.org")).toEqual({
      host: "hub.example.org",
      port: 443,
      https: true,
    });
    expect(parseHubAddress("https://HUB.example.org:8443/x")).toMatchObject({
      host: "hub.example.org",
      port: 8443,
    });
    expect(parseHubAddress("http://192.168.1.5:3000")).toMatchObject({
      host: "192.168.1.5",
      https: false,
    });
    expect(parseHubAddress("")).toBeUndefined();
    expect(parseHubAddress("ftp://x")).toBeUndefined();
  });
  it("answers from the hook without touching the network, and none for an empty list", async () => {
    const config = { HUB_CHECK_DNS_ANSWERS: "hub.a.test=10.0.0.5;10.0.0.6,hub.b.test=" } as never;
    expect(parseDnsAnswers("hub.a.test=10.0.0.5;10.0.0.6,hub.b.test=").get("hub.b.test")).toEqual(
      [],
    );
    expect(await publicDnsLookup(config, "hub.a.test")).toMatchObject({
      addresses: ["10.0.0.5", "10.0.0.6"],
    });
    expect(await publicDnsLookup(config, "hub.b.test")).toMatchObject({
      addresses: [],
      error: "nxdomain",
    });
  });
  it("never opens a TLS connection to a public address", async () => {
    expect(await tlsProbe({ address: "8.8.8.8", port: 443, servername: "x.test" })).toBeUndefined();
  });
});

describe.skipIf(!dbAvailable)("hub setup on the VM", () => {
  let env: TestEnv;
  let w: HubWorld;
  const params = () => ({ id: String(w.eventId) });
  const run = (body: Record<string, unknown>, staff = w.admin) =>
    call(vmRun, { staff, params: params(), body });

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  it("is for admins only", async () => {
    expect((await call(vmView, { params: params() })).status).toBe(401);
    expect((await call(vmView, { staff: w.supervisor, params: params() })).status).toBe(403);
    expect((await run({ step: "hub_running" }, w.supervisor)).status).toBe(403);
    expect((await call(vmView, { staff: w.admin, params: params() })).status).toBe(200);
    expect((await call(vmView, { staff: w.admin, params: { id: "9999" } })).status).toBe(404);
  });

  it("step 1 stores what the browser measured, with who ran it and when", async () => {
    const pass = await run({
      step: "hub_running",
      fetch: {
        url: "https://hub.example.org/api/health",
        reached: true,
        status: 200,
        body: { ok: true, mode: "hub", last_cloud_sync_at: null, pending_scans: 0 },
      },
    });
    expect(pass.status).toBe(200);
    expect(() => api.hubCheckResponse.parse(pass.json)).not.toThrow();
    expect(pass.json.check).toMatchObject({
      step: "hub_running",
      result: "pass",
      checked_by_name: w.admin.name,
      checked_at: env.clock.now,
      source: "vm",
    });
    env.clock.now += 5;
    const down = await run({
      step: "hub_running",
      fetch: {
        url: "https://hub.example.org/api/health",
        reached: false,
        error: "Failed to fetch",
      },
    });
    expect(down.json.check).toMatchObject({ result: "fail", code: "hub_unreachable" });
    const view = await call(vmView, { staff: w.admin, params: params() });
    // The newest result per step is the current state; both stay in the record.
    expect(view.json.checks.filter((c: { step: string }) => c.step === "hub_running")).toHaveLength(
      1,
    );
    expect(view.json.checks.find((c: { step: string }) => c.step === "hub_running").result).toBe(
      "fail",
    );
    expect(view.json.history.length).toBeGreaterThanOrEqual(2);
    expect((await run({ step: "hub_running" })).status).toBe(400);
  });

  it("two results stored in the same second: the later one is the current state", async () => {
    const fetchBody = (reached: boolean) => ({
      step: "hub_running",
      fetch: {
        url: "https://hub.same-second.test/api/health",
        reached,
        status: 200,
        body: { ok: true, mode: "hub" },
      },
    });
    await run(fetchBody(false));
    await run(fetchBody(true));
    const view = await call(vmView, { staff: w.admin, params: params() });
    expect(view.json.checks.find((c: { step: string }) => c.step === "hub_running").result).toBe(
      "pass",
    );
    await run(fetchBody(true));
    await run(fetchBody(false));
    const again = await call(vmView, { staff: w.admin, params: params() });
    expect(again.json.checks.find((c: { step: string }) => c.step === "hub_running").result).toBe(
      "fail",
    );
  });

  it("step 2 passes for a private answer and explains the other answers", async () => {
    const check = async (dns: HubProbes["dns"]) =>
      (
        await runHubCheck(
          env.ctx,
          { id: w.admin.id, name: w.admin.name, role: "admin", pinReset: null },
          w.eventId,
          api.hubCheckRequest.parse({ step: "dns_record", address: "https://hub.example.org" }),
          fixedProbes({ dns }),
        )
      ).check;
    expect(await check(async (host) => ({ host, addresses: ["192.168.50.10"] }))).toMatchObject({
      result: "pass",
    });
    expect(await check(async (host) => ({ host, addresses: ["104.21.5.9"] }))).toMatchObject({
      result: "fail",
      code: "dns_cloudflare_proxy",
    });
    expect(await check(async (host) => ({ host, addresses: [], error: "nxdomain" }))).toMatchObject(
      { code: "dns_no_record" },
    );
    expect(await check(async (host) => ({ host, addresses: ["8.8.8.8"] }))).toMatchObject({
      code: "dns_public_address",
    });
    expect(await check(async (host) => ({ host, addresses: [], error: "ETIMEOUT" }))).toMatchObject(
      { code: "dns_lookup_failed" },
    );
  });

  it("step 2 through the route uses the test hook, and rejects an IP address or no address", async () => {
    env.ctx.config.HUB_CHECK_DNS_ANSWERS = "hub.e2e.test=192.168.50.10,hub.cf.test=104.21.5.9";
    const ok = await run({ step: "dns_record", address: "https://hub.e2e.test" });
    expect(ok.json.check).toMatchObject({ result: "pass", step: "dns_record" });
    const cf = await run({ step: "dns_record", address: "hub.cf.test" });
    expect(cf.json.check.code).toBe("dns_cloudflare_proxy");
    const ip = await run({ step: "dns_record", address: "http://192.168.1.5:3000" });
    expect(ip.json.check.code).toBe("dns_ip_address");
    expect((await run({ step: "dns_record" })).status).toBe(400);
    delete env.ctx.config.HUB_CHECK_DNS_ANSWERS;
  });

  it("step 3 takes the pass from the browser when the VM cannot reach the hub, and warns under 30 days", async () => {
    env.ctx.config.HUB_CHECK_DNS_ANSWERS = "hub.e2e.test=192.168.50.10";
    const day = 86_400;
    const viaBrowser = await run({
      step: "certificate",
      address: "https://hub.e2e.test",
      browser: { reached_over_https: true, cert_expires_at: env.clock.now + 70 * day },
    });
    expect(viaBrowser.json.check).toMatchObject({ result: "pass", step: "certificate" });
    expect(viaBrowser.json.check.details.checked_by).toBe("browser");
    const soon = await run({
      step: "certificate",
      address: "https://hub.e2e.test",
      browser: { reached_over_https: true, cert_expires_at: env.clock.now + 9 * day },
    });
    expect(soon.json.check).toMatchObject({ result: "warn", code: "cert_expiring" });
    const none = await run({ step: "certificate", address: "https://hub.e2e.test" });
    expect(none.json.check.code).toBe("cert_unverified");
    delete env.ctx.config.HUB_CHECK_DNS_ANSWERS;
  });

  it("step 3 prefers the VM's own handshake when it can reach the hub", async () => {
    const res = await runHubCheck(
      env.ctx,
      { id: w.admin.id, name: w.admin.name, role: "admin", pinReset: null },
      w.eventId,
      api.hubCheckRequest.parse({ step: "certificate", address: "https://hub.example.org" }),
      fixedProbes({
        tls: async (t) => {
          expect(t).toEqual({ address: "192.168.50.10", port: 443, servername: "hub.example.org" });
          return { authorized: false, expiresAt: env.clock.now + 100 * 86_400 };
        },
      }),
    );
    expect(res.check).toMatchObject({ result: "fail", code: "cert_not_trusted" });
  });

  it("step 4 passes only for a hub that was seen recently and has pulled", async () => {
    // createHubWorld linked the hub (its meta pull happened) but no ticket pull yet.
    expect((await run({ step: "link_hub" })).json.check).toMatchObject({
      result: "fail",
      code: "hub_never_pulled",
    });
    await w.pull();
    const ok = await run({ step: "link_hub" });
    expect(ok.json.check).toMatchObject({ result: "pass", step: "link_hub" });
    const hubId = getLink(w.hub)!.deviceId;
    expect(ok.json.check.device_id).toBe(hubId);

    env.clock.now += 600;
    expect((await run({ step: "link_hub" })).json.check.code).toBe("hub_not_seen");
    await w.pull();
    await env.handle.db.update(devices).set({ revoked: true }).where(eq(devices.id, hubId));
    expect((await run({ step: "link_hub" })).json.check.code).toBe("hub_revoked");
    await env.handle.db.update(devices).set({ revoked: false }).where(eq(devices.id, hubId));
  });

  it("steps that read the hub's own data are skipped on the VM and write nothing", async () => {
    const before = await env.handle.db.select().from(hubChecks);
    for (const step of ["data_match", "phone_via_hub", "offline_scan"]) {
      const res = await run({ step });
      expect(res.json).toMatchObject({
        stored: false,
        check: { result: "skipped", code: "run_on_hub" },
      });
    }
    expect(await env.handle.db.select().from(hubChecks)).toHaveLength(before.length);
    expect((await run({ step: "offline_scan", action: "start" })).status).toBe(400);
  });

  it("accepts the hub's results once per id, for the hub's own event only", async () => {
    const hubToken = getLink(w.hub)!.token;
    const check = {
      id: "6f1c6b0e-0000-4000-8000-000000000001",
      device_id: null,
      step: "local_dns",
      result: "pass",
      code: null,
      summary: "ok",
      details: { url: "https://hub.example.org" },
      checked_at: env.clock.now,
      checked_by: w.admin.id,
      checked_by_name: "Ada",
    };
    expect((await call(syncHubChecks, { body: { checks: [check] } })).status).toBe(401);
    expect((await call(syncHubChecks, { staff: w.admin, body: { checks: [check] } })).status).toBe(
      401,
    );
    const first = await call(syncHubChecks, { bearer: hubToken, body: { checks: [check] } });
    expect(first.json.acknowledged).toEqual([check.id]);
    await call(syncHubChecks, { bearer: hubToken, body: { checks: [check] } });
    const rows = await env.handle.db.select().from(hubChecks).where(eq(hubChecks.id, check.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "hub", eventId: w.eventId, checkedByName: "Ada" });
    expect(rows[0]!.deviceId).toBe(getLink(w.hub)!.deviceId);
    // A phone's token is not a hub's.
    const phone = await w.enrolAtVm("Gate A", "entry");
    expect(
      (await call(syncHubChecks, { bearer: phone.token, body: { checks: [check] } })).status,
    ).toBe(403);
  });

  it("answers the hub's counts: tickets by status and the staff the hub would hold", async () => {
    const hubToken = getLink(w.hub)!.token;
    const a = await w.makeTicket(0);
    await w.makeTicket(0);
    await w.cancel(a.id);
    const res = await call(syncCounts, { bearer: hubToken });
    expect(() => api.syncCountsResponse.parse(res.json)).not.toThrow();
    expect(res.json.tickets).toMatchObject({ valid: 1, cancelled: 1 });
    expect(res.json.staff).toBe(3);
    expect((await call(syncCounts, { staff: w.admin })).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)("hub setup on the hub", () => {
  let env: TestEnv;
  let w: HubWorld;
  const url = () => `http://hub.test/api/events/${w.eventId}/hub-setup/checks`;
  const cookie = (id: string) => ({ cookie: `${SESSION_COOKIE}=${createHubSession(w.hub, id)}` });
  /** The hub routes read the event id from the URL, so call them with a real path. */
  async function hubCall(
    handler: (req: Request) => Promise<Response>,
    body: Record<string, unknown> | undefined,
    who: { id: string } | null = w.admin,
  ) {
    const res = await handler(
      new Request(body ? url() : `http://hub.test/api/events/${w.eventId}/hub-setup`, {
        method: body ? "POST" : "GET",
        headers: {
          ...(who ? cookie(who.id) : {}),
          ...(body
            ? { "content-type": "application/json", origin: "http://hub.test", host: "hub.test" }
            : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  }
  const post = (body: Record<string, unknown>, who?: { id: string }) =>
    hubCall(hubRunCheckRoute, body, who);

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  it("serves the page to admins only, and only for the hub's event", async () => {
    expect((await hubCall(hubSetupViewRoute, undefined, null)).status).toBe(401);
    expect((await hubCall(hubSetupViewRoute, undefined, w.supervisor)).status).toBe(403);
    const ok = await hubCall(hubSetupViewRoute, undefined);
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ mode: "hub", event_id: w.eventId });
    expect(ok.json.vm_only_steps).toEqual(["dns_record", "link_hub"]);
    const other = await hubSetupViewRoute(
      new Request("http://hub.test/api/events/9999/hub-setup", {
        headers: cookie(w.admin.id),
      }),
    );
    expect(other.status).toBe(404);
    expect((await post({ step: "hub_running" }, w.supervisor)).status).toBe(403);
  });

  it("keeps browser results locally and uploads them to the VM once", async () => {
    const stored = await post({
      step: "local_dns",
      fetch: {
        url: "https://hub.example.org/api/health",
        reached: true,
        status: 200,
        body: { ok: true, mode: "hub" },
      },
    });
    expect(stored.json).toMatchObject({
      stored: true,
      check: { step: "local_dns", result: "pass", source: "hub", checked_by_name: w.admin.name },
    });
    env.clock.now += 3;
    const failed = await post({
      step: "local_dns",
      fetch: { url: "https://hub.example.org/api/health", reached: false },
    });
    expect(failed.json.check.code).toBe("local_dns_unreachable");

    const pushed = await w.push();
    expect(pushed.checks).toBe(2);
    expect((await w.push()).checks).toBe(0);
    const onVm = await env.handle.db
      .select()
      .from(hubChecks)
      .where(eq(hubChecks.step, "local_dns"));
    expect(onVm).toHaveLength(2);
    expect(onVm.every((r) => r.source === "hub")).toBe(true);
    expect(onVm.map((r) => r.id).sort()).toEqual(
      [stored.json.check.id, failed.json.check.id].sort(),
    );
    const view = await hubCall(hubSetupViewRoute, undefined);
    expect(view.json.checks.find((c: { step: string }) => c.step === "local_dns").result).toBe(
      "fail",
    );
  });

  it("skips the steps that need the VM", async () => {
    for (const step of ["dns_record", "link_hub"]) {
      const res = await post({ step });
      expect(res.json).toMatchObject({
        stored: false,
        check: { result: "skipped", code: "needs_vm" },
      });
    }
  });

  it("step 6 compares counts with the VM, tolerating one pull interval, and skips when the VM is unreachable", async () => {
    await w.makeTicket(0);
    await w.makeTicket(1);
    await w.pull();
    expect((await post({ step: "data_match" })).json.check).toMatchObject({
      result: "pass",
      step: "data_match",
    });
    // A ticket issued on the VM since the last pull: the hub is a moment behind, which is fine.
    await w.makeTicket(0);
    env.clock.now += 3;
    const behind = await post({ step: "data_match" });
    expect(behind.json.check.result).toBe("pass");
    expect(behind.json.check.summary).toContain("1 ticket behind");
    // Not pulled for longer than one interval: fail.
    env.clock.now += 120;
    const stale = await post({ step: "data_match" });
    expect(stale.json.check).toMatchObject({ result: "fail", code: "data_stale" });
    // A hub holding more than the VM is a mismatch, whatever the pull time.
    await w.pull();
    const { id } = await w.makeTicket(0);
    await w.pull();
    await w.cancel(id);
    setState(w.hub, "last_pull_at", String(env.clock.now));
    // Someone on the hub who the VM does not list: the hub must never hold more than the VM.
    w.hub.db
      .insert(hubSide.staff)
      .values({ id: randomUUID(), name: "ghost", pinHash: "x", role: "staff" })
      .run();
    const mismatch = await post({ step: "data_match" });
    expect(mismatch.json.check).toMatchObject({ result: "fail", code: "data_mismatch" });

    w.cutUplink();
    const down = await post({ step: "data_match" });
    expect(down.json).toMatchObject({
      stored: false,
      check: { result: "skipped", code: "needs_vm" },
    });
    w.restoreUplink();
  });

  it("step 7 passes when a phone reported through the hub in the last 5 minutes", async () => {
    expect((await post({ step: "phone_via_hub" })).json.check).toMatchObject({
      result: "fail",
      code: "no_phones",
    });
    await w.pull();
    const phone = await w.enrolAtHub("Gate A", "entry");
    const ticket = await w.makeTicket(0);
    await w.pull();
    // Fresh enrolment but nothing sent through the hub yet: the phone has no contact time.
    const claimed = await w.hubClaim(phone, w.scanBody(phone, ticket.id));
    expect(claimed.status).toBe(200);
    expect((await post({ step: "phone_via_hub" })).json.check).toMatchObject({
      result: "pass",
      step: "phone_via_hub",
    });
    env.clock.now += 400;
    expect((await post({ step: "phone_via_hub" })).json.check.code).toBe("phone_quiet");
  });

  it("step 8 needs a started test, an outage the hub noticed, a scan inside it and the VM's receipt", async () => {
    expect((await post({ step: "offline_scan" })).json.check.code).toBe("offline_not_tested");

    const phone = await w.enrolAtHub("Gate B", "entry");
    const ticket = await w.makeTicket(0, "rehearsal");
    await w.pull();
    const start = await post({ step: "offline_scan", action: "start" });
    expect(start.json.stored).toBe(false);
    expect(getState(w.hub, "offline_test_started_at")).toBe(String(env.clock.now));
    // Uplink still up: nothing to see yet.
    expect((await post({ step: "offline_scan" })).json.check.code).toBe("offline_no_outage");

    // Unplug: the next pull fails and the outage starts at the last contact that worked.
    env.clock.now += 5;
    w.cutUplink();
    await expect(w.pull()).rejects.toThrow();
    expect(uplinkOutages(w.hub).at(-1)).toMatchObject({ to: null });
    expect((await post({ step: "offline_scan" })).json.check.code).toBe("offline_no_scan");

    env.clock.now += 30;
    const scanned = await w.hubClaim(phone, w.scanBody(phone, ticket.id, { gate: "Gate B" }));
    expect(scanned.status).toBe(200);
    expect((await post({ step: "offline_scan" })).json.check.code).toBe("offline_not_delivered");

    // Plug back in: the push delivers the scan and ends the outage.
    env.clock.now += 20;
    w.restoreUplink();
    expect((await w.push()).scans).toBeGreaterThanOrEqual(1);
    const pass = await post({ step: "offline_scan" });
    expect(pass.json).toMatchObject({
      stored: true,
      check: { result: "pass", step: "offline_scan" },
    });
    expect(pass.json.check.details.vm_received_at).toBeGreaterThanOrEqual(
      pass.json.check.details.scan_received_at,
    );
    expect(uplinkOutages(w.hub).at(-1)!.to).not.toBeNull();
    await w.push();
    const stored = await env.handle.db
      .select()
      .from(hubChecks)
      .where(eq(hubChecks.step, "offline_scan"));
    // Every run is recorded; the newest is the pass.
    expect(stored).toHaveLength(5);
    expect(stored.filter((r) => r.result === "pass")).toHaveLength(1);
  });
});
