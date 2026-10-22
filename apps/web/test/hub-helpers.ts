/**
 * Hub test harness: a VM (the MariaDB test environment, real route handlers) and a hub (a real
 * SQLite file with the real migrations) wired together in one process. The hub's `fetch` towards
 * the VM calls the VM's route handlers directly, and `world.cutUplink()` makes it fail like a dead
 * link, so "uplink cut" tests need no network.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSetupCode } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as cancelRoute } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as enrollRoute } from "../src/app/api/devices/enroll/route";
import { POST as hubSetup } from "../src/app/api/hubs/setup/route";
import { POST as hubEnroll } from "../src/app/api/hubs/enroll/route";
import { GET as syncMeta } from "../src/app/api/sync/meta/route";
import { GET as syncTickets } from "../src/app/api/sync/tickets/route";
import { GET as syncScansGet, POST as syncScansPost } from "../src/app/api/sync/scans/route";
import { POST as syncDevices } from "../src/app/api/sync/devices/route";
import { POST as vmClaim } from "../src/app/api/claim/route";
import { POST as vmExit } from "../src/app/api/exit/route";
import { GET as vmSync } from "../src/app/api/sync/route";
import { POST as vmLogin } from "../src/app/api/auth/login/route";
import { loadConfig } from "../src/server/config";
import { setHubContext, type HubContext } from "../src/hub/context";
import { openHubDb } from "../src/hub/db";
import { linkHubToVm } from "../src/hub/link";
import { vmClientFor, pullCycle, pushCycle } from "../src/hub/vmsync";
import * as hubRoutes from "../src/hub/routes";
import { call, eventBody, makeStaff, newKey, type TestEnv, type TestStaff } from "./helpers";

export const VM_URL = "http://vm.test";

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const VM_ROUTES: Record<string, Handler> = {
  "POST /api/hubs/enroll": hubEnroll,
  "GET /api/sync/meta": syncMeta,
  "GET /api/sync/tickets": syncTickets,
  "GET /api/sync/scans": syncScansGet,
  "POST /api/sync/scans": syncScansPost,
  "POST /api/sync/devices": syncDevices,
  "POST /api/claim": vmClaim,
  "POST /api/exit": vmExit,
  "GET /api/sync": vmSync,
  "POST /api/devices/enroll": enrollRoute,
  "POST /api/auth/login": vmLogin,
};

export interface HubDevice {
  id: string;
  token: string;
}

export interface HubWorld {
  vm: TestEnv;
  hub: HubContext;
  admin: TestStaff;
  supervisor: TestStaff;
  staff: TestStaff;
  eventId: number;
  dbPath: string;
  /** Hub's fetch towards the VM fails like a dead uplink until `restoreUplink()`. */
  cutUplink(): void;
  restoreUplink(): void;
  /** A `fetch` for the scanner client / hub that calls the VM's routes (obeys the uplink switch). */
  vmFetch: typeof fetch;
  /** Issues a ticket on the VM. */
  makeTicket(type: number, name?: string): Promise<{ id: string; token: string }>;
  cancel(ticketId: string): Promise<void>;
  /** A phone enrolled at the VM (with the hub possibly never hearing of it until the next pull). */
  enrolAtVm(
    gate: string,
    direction: string,
  ): Promise<HubDevice & { bundle: Record<string, unknown> }>;
  /** A phone enrolled at the hub from its cached codes (no VM call). Pulls first so the code is cached. */
  enrolAtHub(
    gate: string,
    direction: string,
  ): Promise<HubDevice & { bundle: Record<string, unknown> }>;
  pull(): ReturnType<typeof pullCycle>;
  push(): ReturnType<typeof pushCycle>;
  /** Hub-side `/claim` and `/exit` as a phone would call them. */
  hubClaim(device: HubDevice, body: Record<string, unknown>): ReturnType<typeof call>;
  hubExit(device: HubDevice, body: Record<string, unknown>): ReturnType<typeof call>;
  scanBody(
    device: HubDevice,
    ticketId: string,
    extra?: Record<string, unknown>,
  ): Record<string, unknown>;
  close(): Promise<void>;
}

/** Creates the event, three staff accounts, the hub database and links the hub to the event. */
export async function createHubWorld(
  vm: TestEnv,
  options: { eventBody?: Record<string, unknown> } = {},
): Promise<HubWorld> {
  const [admin, supervisor, staff] = await Promise.all([
    makeStaff(vm, "admin"),
    makeStaff(vm, "supervisor"),
    makeStaff(vm, "staff"),
  ]);
  const created = await call(createEvent, {
    staff: admin,
    body:
      options.eventBody ??
      eventBody(vm.clock.now + 86400, {
        ticket_types: [
          { idx: 0, name: "Single" },
          { idx: 1, name: "Limited", entry_rule: { mode: "limited", max_admits: 3 } },
          { idx: 2, name: "Unlimited", entry_rule: { mode: "unlimited" } },
        ],
      }),
  });
  const eventId = created.json.id as number;

  const dir = mkdtempSync(join(tmpdir(), "eqr-hub-"));
  const dbPath = join(dir, "hub.sqlite");
  const config = loadConfig({
    NODE_ENV: "test",
    APP_MODE: "hub",
    HUB_DB_PATH: dbPath,
    SYNC_HORIZON_SECONDS: "1",
  });
  // The VM holds back rows younger than the horizon, as in production; `pull()` lets the clock run past it.
  vm.ctx.config.SYNC_HORIZON_SECONDS = 1;
  const opened = await openHubDb(dbPath, { migrate: true });
  let uplinkUp = true;
  const vmFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!uplinkUp) throw new TypeError("fetch failed");
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    const handler = VM_ROUTES[`${method} ${url.pathname}`];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(new Request(url, { ...init, method }), { params: Promise.resolve({}) });
  }) as typeof fetch;
  const hub: HubContext = {
    config,
    db: opened.db,
    sqlite: opened.sqlite,
    now: () => vm.clock.now,
    vmFetch,
  };
  setHubContext(hub);

  const setup = await call(hubSetup, {
    staff: supervisor,
    body: { event_id: eventId, label: "hub" },
  });
  if (setup.status !== 201) throw new Error(`hub setup failed: ${setup.text}`);
  await linkHubToVm(hub, { vmUrl: VM_URL, code: setup.json.setup_code });

  const world: HubWorld = {
    vm,
    hub,
    admin,
    supervisor,
    staff,
    eventId,
    dbPath,
    cutUplink: () => void (uplinkUp = false),
    restoreUplink: () => void (uplinkUp = true),
    vmFetch,
    async makeTicket(type, name) {
      const res = await call(generate, {
        staff,
        params: { id: String(eventId) },
        body: { idempotency_key: newKey(), ticket_type: type, holder_name: name ?? `T${type}` },
      });
      if (res.status !== 201) throw new Error(`ticket failed: ${res.text}`);
      return { id: res.json.tickets[0].ticket_id, token: res.json.tickets[0].token };
    },
    async cancel(ticketId) {
      const res = await call(cancelRoute, { staff: admin, params: { id: ticketId }, body: {} });
      if (res.status !== 200) throw new Error(`cancel failed: ${res.text}`);
    },
    async enrolAtVm(gate, direction) {
      const created = await call(enrollRoute, {
        staff: supervisor,
        body: { event_id: eventId, gate, direction },
      });
      const decoded = decodeSetupCode(created.json.setup_qr);
      if (!decoded.ok) throw new Error("bad setup qr");
      const id = randomUUID();
      const res = await call(enrollRoute, { body: { code: decoded.setup.code, device_id: id } });
      if (res.status !== 200) throw new Error(`enrol failed: ${res.text}`);
      return { id, token: res.json.device_token, bundle: res.json.key_bundle };
    },
    async enrolAtHub(gate, direction) {
      const created = await call(enrollRoute, {
        staff: supervisor,
        body: { event_id: eventId, gate, direction },
      });
      const decoded = decodeSetupCode(created.json.setup_qr);
      if (!decoded.ok) throw new Error("bad setup qr");
      await world.pull();
      const id = randomUUID();
      const res = await call(hubRoutes.enroll, {
        body: { code: decoded.setup.code, device_id: id },
      });
      if (res.status !== 200) throw new Error(`hub enrol failed: ${res.text}`);
      return { id, token: res.json.device_token, bundle: res.json.key_bundle };
    },
    pull: () => {
      vm.clock.now += 2;
      return pullCycle(hub, vmClientFor(hub)!);
    },
    push: () => pushCycle(hub, vmClientFor(hub)!),
    hubClaim: (device, body) => call(hubRoutes.claim, { bearer: device.token, body }),
    hubExit: (device, body) => call(hubRoutes.exit, { bearer: device.token, body }),
    scanBody: (device, ticketId, extra = {}) => ({
      scan_id: randomUUID(),
      ticket_id: ticketId,
      device_id: device.id,
      staff_id: staff.id,
      gate: "Gate A",
      scanned_at: vm.clock.now,
      ...extra,
    }),
    async close() {
      setHubContext(undefined);
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return world;
}

export { call };
