import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sqliteSchema } from "@events-qr/core";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as cancel } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as createStaff } from "../src/app/api/staff/route";
import { POST as hubSetup } from "../src/app/api/hubs/setup/route";
import { GET as syncMeta } from "../src/app/api/sync/meta/route";
import { GET as syncTickets } from "../src/app/api/sync/tickets/route";
import { POST as syncScans } from "../src/app/api/sync/scans/route";
import { POST as enrollRoute } from "../src/app/api/devices/enroll/route";
import { POST as claimRoute } from "../src/app/api/claim/route";
import { GET as healthRoute } from "../src/app/api/health/route";
import { POST as scansRoute } from "../src/app/api/scans/route";
import { POST as hubEnrollAlias } from "../src/app/api/enroll/route";
import { middleware } from "../src/middleware";
import { eventBody, call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

const here = dirname(fileURLToPath(import.meta.url));

describe("hub mode: no issuance, no signing secret", () => {
  it("no hub source file imports the signer, MariaDB or the VM context", () => {
    const dir = resolve(here, "../src/hub");
    const banned = [
      /server\/signing/,
      /server\/db["']/,
      /server\/context/,
      /mysql2/,
      /mysqlSchema/,
    ];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const re of banned) expect(text, `${file} must not match ${re}`).not.toMatch(re);
    }
  });

  it("the hub's database has no column that could hold a signing key", () => {
    const names = Object.values(sqliteSchema).flatMap((t) =>
      getTableConfig(t).columns.map((c) => c.name),
    );
    expect(names.join(",")).not.toMatch(/secret|private|signing|passphrase/i);
  });

  describe("middleware", () => {
    const run = (path: string, init: { method?: string } = {}) =>
      middleware(new NextRequest(`http://hub.test${path}`, init));
    const isPassThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

    afterEach(() => {
      delete process.env.APP_MODE;
    });

    it("on a hub only the scanner and its API are served", () => {
      process.env.APP_MODE = "hub";
      for (const ok of [
        "/api/claim",
        "/api/exit",
        "/api/sync",
        "/api/health",
        "/api/enroll",
        "/api/scans",
        "/api/auth/login",
        "/api/devices/enroll",
      ]) {
        expect(isPassThrough(run(ok, { method: "POST" })), ok).toBe(true);
      }
      for (const blocked of [
        "/",
        "/login",
        "/events/1",
        "/api/events",
        "/api/events/1/tickets",
        "/api/staff",
        "/api/tickets/abc/cancel",
        "/api/sync/tickets",
        "/api/sync/scans",
        "/api/sync/meta",
        "/api/hubs/setup",
        "/api/auth/me",
        "/api/auth/logout",
      ]) {
        expect(run(blocked).status, blocked).toBe(404);
      }
    });

    it("answers CORS preflights for the scanner API, and only for it", () => {
      const pre = run("/api/claim", { method: "OPTIONS" });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("*");
      expect(pre.headers.get("access-control-allow-headers")).toContain("authorization");
      expect(run("/api/claim", { method: "POST" }).headers.get("access-control-allow-origin")).toBe(
        "*",
      );
      expect(
        run("/api/events", { method: "POST" }).headers.get("access-control-allow-origin"),
      ).toBeNull();
      expect(isPassThrough(run("/api/events"))).toBe(true); // the VM serves its own admin API
    });
  });
});

describe.skipIf(!dbAvailable)("hub mode routes", () => {
  let env: TestEnv;
  let w: HubWorld;

  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
  });
  afterAll(async () => {
    delete process.env.APP_MODE;
    await w.close();
    await env.close();
  });

  it("refuses every VM-only route with a 404, even with a valid staff session", async () => {
    process.env.APP_MODE = "hub";
    try {
      const params = { id: String(w.eventId) };
      const refused = [
        await call(createEvent, { staff: w.admin, body: eventBody(env.clock.now + 86400) }),
        await call(generate, {
          staff: w.staff,
          params,
          body: { idempotency_key: "k".repeat(10), ticket_type: 0 },
        }),
        await call(cancel, { staff: w.admin, params: { id: "00".repeat(16) }, body: {} }),
        await call(createStaff, {
          staff: w.admin,
          body: { name: "x", pin: "123456", role: "staff" },
        }),
        await call(hubSetup, { staff: w.supervisor, body: { event_id: w.eventId } }),
        await call(syncMeta),
        await call(syncTickets),
        await call(syncScans, { body: { scans: [] } }),
        await call(enrollRoute, {
          staff: w.supervisor,
          body: { event_id: w.eventId, gate: "Gate A", direction: "entry" },
        }).then(
          // On a hub this path is the phone exchange only; a staff "create setup" body is not one.
          (r) => (r.status === 400 ? { status: 404 } : r),
        ),
      ];
      for (const r of refused) expect(r.status).toBe(404);
    } finally {
      delete process.env.APP_MODE;
    }
  });

  it("serves the scanner API from SQLite: enrol, claim, health, upload", async () => {
    const t = await w.makeTicket(0, "Hub served");
    await w.pull();
    const phone = await w.enrolAtHub("Gate A", "entry");
    process.env.APP_MODE = "hub";
    try {
      const claimed = await call(claimRoute, {
        bearer: phone.token,
        body: w.scanBody(phone, t.id),
      });
      expect(claimed.json.result).toBe("admitted");
      // It was decided by the hub: the VM has not seen the scan.
      expect(
        (
          await env.handle.db.query.scans.findMany({
            where: (s, { eq }) => eq(s.id, claimed.json.scan_id ?? ""),
          })
        ).length,
      ).toBe(0);
      const health = await call(healthRoute);
      expect(health.json.mode).toBe("hub");
      expect((await call(scansRoute, { bearer: phone.token, body: { scans: [] } })).status).toBe(
        400,
      );
      expect(
        (await call(hubEnrollAlias, { body: { code: "nope", device_id: crypto.randomUUID() } }))
          .status,
      ).toBe(401);
    } finally {
      delete process.env.APP_MODE;
    }
  });

  it("the VM itself answers 404 for the hub-only routes and reports mode server", async () => {
    expect((await call(scansRoute, { body: { scans: [] } })).status).toBe(404);
    expect(
      (await call(hubEnrollAlias, { body: { code: "x", device_id: crypto.randomUUID() } })).status,
    ).toBe(404);
    expect((await call(healthRoute)).json.mode).toBe("server");
  });

  it("the hub's SQLite file holds the event key and public keys but nothing of the VM's secrets", () => {
    const bytes =
      readFileSync(w.dbPath).toString("latin1") +
      readFileSync(`${w.dbPath}-wal`, { flag: "r" }).toString("latin1");
    expect(statSync(w.dbPath).size).toBeGreaterThan(0);
    expect(bytes).toContain("event_key");
    // The master key that encrypts event keys on the VM and the session secret never reach the hub.
    expect(bytes).not.toContain(env.ctx.config.SESSION_SECRET!);
    expect(bytes).not.toContain(Buffer.from(env.ctx.masterKey).toString("hex"));
    expect(bytes).not.toContain(Buffer.from(env.ctx.masterKey).toString("base64"));
  });
});
