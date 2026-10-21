import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { POST as claim } from "../src/app/api/claim/route";
import { POST as exit } from "../src/app/api/exit/route";
import { GET as sync } from "../src/app/api/sync/route";
import { GET as health } from "../src/app/api/health/route";
import { POST as login } from "../src/app/api/auth/login/route";
import { EnrollFailed, enrollFromSetupQr, syncAll } from "../src/scanner/sync";
import { HttpClient, NetworkError, AuthError } from "../src/scanner/client";
import { MemoryStore } from "../src/scanner/memoryStore";
import { processScan } from "../src/scanner/pipeline";
import { isSupervisor, loginStaff } from "../src/scanner/staff";
import {
  call,
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  TEST_PIN,
  type TestEnv,
  type TestStaff,
} from "./helpers";

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

describe.skipIf(!dbAvailable)("scanner enrolment, sync and scan against the real routes", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let supervisor: TestStaff;
  let staff: TestStaff;
  let eventId: number;
  const routes: Record<string, Handler> = {
    "POST /api/devices/enroll": enroll,
    "POST /api/claim": claim,
    "POST /api/exit": exit,
    "GET /api/sync": sync,
    "GET /api/health": health as unknown as Handler,
    "POST /api/auth/login": login,
  };
  /** A fetch that calls the route handlers directly, as the browser would call the server. */
  const fakeFetch: typeof fetch = async (input, init) => {
    const req = new Request(input as string, init);
    const handler = routes[`${req.method} ${new URL(req.url).pathname}`];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(req, { params: Promise.resolve({}) });
  };

  async function setupQr(direction = "entry", gate = "Gate A") {
    const res = await call(enroll, {
      staff: supervisor,
      body: { event_id: eventId, gate, direction, label: "Phone 1" },
    });
    return res.json.setup_qr as string;
  }
  async function ticket(body: Record<string, unknown> = {}) {
    const res = await call(generate, {
      staff,
      params: { id: String(eventId) },
      body: { idempotency_key: newKey(), ticket_type: 2, holder_name: "Ada", ...body },
    });
    return res.json.tickets[0] as { ticket_id: string; token: string };
  }

  beforeAll(async () => {
    env = await createTestEnv();
    [admin, supervisor, staff] = await Promise.all([
      makeStaff(env, "admin"),
      makeStaff(env, "supervisor"),
      makeStaff(env, "staff", "Sam"),
    ]);
    eventId = (await call(createEvent, { staff: admin, body: eventBody(env.clock.now + 3600) }))
      .json.id;
  });
  afterAll(() => env.close());

  it("enrols from a DEV1: code, stores the device and runs the full ticket sync before going ready", async () => {
    const before = await ticket();
    const qr = await setupQr();
    const store = new MemoryStore();
    const device = await enrollFromSetupQr(store, qr, {
      fetch: fakeFetch,
      originOverride: "http://localhost:3000",
    });
    expect(device).toMatchObject({
      gate: "Gate A",
      direction: "entry",
      label: "Phone 1",
      synced: true,
    });
    expect(device.bundle.event_id).toBe(eventId);
    expect(device.ticketTypes.map((t) => t.name)).toEqual(["GA", "VIP", "Staff"]);
    expect(await store.ticketCount()).toBeGreaterThanOrEqual(1);
    expect((await store.getTicket(before.ticket_id))?.holder_name).toBe("Ada");
    expect((await store.getDevice())?.cursor).not.toBeNull();

    // The one-time code cannot be used twice.
    await expect(
      enrollFromSetupQr(new MemoryStore(), qr, { fetch: fakeFetch, originOverride: "http://x" }),
    ).rejects.toMatchObject({ reason: "wrong_code" });
  });

  it("rejects things that are not setup codes, and reports an unreachable server", async () => {
    const store = new MemoryStore();
    await expect(enrollFromSetupQr(store, "EVT1:ABC", { fetch: fakeFetch })).rejects.toMatchObject({
      reason: "not_setup",
    });
    await expect(
      enrollFromSetupQr(store, "DEV1:garbage!", { fetch: fakeFetch }),
    ).rejects.toBeInstanceOf(EnrollFailed);
    const down: typeof fetch = async () => {
      throw new TypeError("offline");
    };
    await expect(
      enrollFromSetupQr(store, await setupQr(), { fetch: down, originOverride: "http://x" }),
    ).rejects.toMatchObject({ reason: "network" });
    expect(await store.getDevice()).toBeUndefined();
  });

  it("scans end to end: green, then red 'already inside', exit blue; sync picks up new tickets", async () => {
    const store = new MemoryStore();
    const device = await enrollFromSetupQr(store, await setupQr("both"), {
      fetch: fakeFetch,
      originOverride: "http://localhost:3000",
    });
    const client = new HttpClient({
      baseUrl: "http://localhost:3000",
      token: device.token,
      fetch: fakeFetch,
    });
    env.clock.now += 5; // tests run with no sync horizon, so keep the new ticket past the cursor
    const t = await ticket({ ticket_type: 2, holder_name: "Grace" });
    // Issued after the sync: amber until the next sync.
    const deps = {
      store,
      client,
      device: (await store.getDevice())!,
      staff: await loginStaff("http://localhost:3000", "Sam", TEST_PIN, fakeFetch),
      now: () => env.clock.now,
      newId: () => randomUUID(),
    };
    expect(deps.staff).toMatchObject({ id: staff.id, role: "staff" });
    expect((await processScan(deps, t.token, "entry")).kind).toBe("unknown_ticket");

    const synced = await syncAll(store, client, () => env.clock.now);
    deps.device = synced;
    expect(synced.clockOffset).toBe(0);
    expect(await processScan(deps, t.token, "entry")).toMatchObject({
      kind: "admitted",
      name: "Grace",
    });
    expect(await processScan(deps, t.token, "entry")).toMatchObject({
      kind: "inside",
      name: "Grace",
    });
    expect(await processScan(deps, t.token, "exit")).toMatchObject({
      kind: "exited",
      name: "Grace",
    });
    await client.health();
  });

  it("a revoked or unknown token is an AuthError; an unreachable server is a NetworkError", async () => {
    const bad = new HttpClient({ baseUrl: "http://x", token: "nope", fetch: fakeFetch });
    await expect(bad.sync(null)).rejects.toBeInstanceOf(AuthError);
    const down = new HttpClient({
      baseUrl: "http://x",
      token: "t",
      fetch: async () => {
        throw new TypeError("offline");
      },
    });
    await expect(down.health()).rejects.toBeInstanceOf(NetworkError);
  });

  it("staff login returns the role; wrong PIN is rejected", async () => {
    const sup = await loginStaff("http://x", supervisor.name, TEST_PIN, fakeFetch);
    expect(isSupervisor(sup)).toBe(true);
    expect(isSupervisor(await loginStaff("http://x", "Sam", TEST_PIN, fakeFetch))).toBe(false);
    await expect(loginStaff("http://x", "Sam", "wrong", fakeFetch)).rejects.toMatchObject({
      status: 401,
    });
  });
});
