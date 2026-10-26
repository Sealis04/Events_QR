import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mysqlSchema } from "@events-qr/core";
import { SESSION_COOKIE, createSessionValue } from "../src/server/auth";
import { setContext } from "../src/server/context";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as logout } from "../src/app/api/auth/logout/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { POST as createStaff } from "../src/app/api/staff/route";
import { GET as listEvents, POST as createEvent } from "../src/app/api/events/route";
import { GET as getEvent, PATCH as patchEvent } from "../src/app/api/events/[id]/route";
import { POST as addType } from "../src/app/api/events/[id]/ticket-types/route";
import { PATCH as patchType } from "../src/app/api/events/[id]/ticket-types/[idx]/route";
import { GET as listTickets, POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as importTickets } from "../src/app/api/events/[id]/tickets/import/route";
import { GET as stats } from "../src/app/api/events/[id]/stats/route";
import { POST as cancel } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as resend } from "../src/app/api/tickets/[id]/resend/route";
import { POST as transfer } from "../src/app/api/tickets/[id]/transfer/route";
import { POST as enroll } from "../src/app/api/devices/enroll/route";
import { GET as getTicket } from "../src/app/api/tickets/[id]/route";
import { GET as exportTickets } from "../src/app/api/events/[id]/tickets/export/route";
import { GET as eventDevices } from "../src/app/api/events/[id]/devices/route";
import { POST as manualAdmit } from "../src/app/api/events/[id]/admit/route";
import { GET as overrides } from "../src/app/api/events/[id]/overrides/route";
import { GET as eventStaff } from "../src/app/api/events/[id]/staff/route";
import { PUT as setEventStaff } from "../src/app/api/events/[id]/staff/[staffId]/route";
import { PATCH as patchDevice } from "../src/app/api/devices/[id]/route";
import { POST as revokeDevice } from "../src/app/api/devices/[id]/revoke/route";
import { POST as reviewConflict } from "../src/app/api/scans/[id]/review/route";
import { GET as conflicts } from "../src/app/api/events/[id]/conflicts/route";

import { GET as syncTickets } from "../src/app/api/sync/tickets/route";
import { POST as syncScans } from "../src/app/api/sync/scans/route";
import {
  call,
  createTestEnv,
  dbAvailable,
  makeStaff,
  PRIVILEGED_PIN,
  TEST_PIN,
  type TestEnv,
  type TestStaff,
} from "./helpers";

type Role = "staff" | "supervisor" | "admin";
const RANK: Record<Role, number> = { staff: 1, supervisor: 2, admin: 3 };
const ID = "00".repeat(16);

/** Every staff-facing endpoint and the lowest role the spec's API table allows. */
const staffEndpoints: {
  name: string;
  handler: Parameters<typeof call>[0];
  need: Role;
  opts?: Parameters<typeof call>[1];
}[] = [
  { name: "GET /auth/me", handler: me, need: "staff" },
  { name: "POST /staff", handler: createStaff, need: "admin", opts: { body: {} } },
  { name: "GET /events", handler: listEvents, need: "staff" },
  { name: "POST /events", handler: createEvent, need: "admin", opts: { body: {} } },
  { name: "GET /events/{id}", handler: getEvent, need: "staff", opts: { params: { id: "1" } } },
  {
    name: "PATCH /events/{id}",
    handler: patchEvent,
    need: "admin",
    opts: { method: "PATCH", params: { id: "1" }, body: {} },
  },
  {
    name: "POST /events/{id}/ticket-types",
    handler: addType,
    need: "admin",
    opts: { params: { id: "1" }, body: {} },
  },
  {
    name: "PATCH /events/{id}/ticket-types/{idx}",
    handler: patchType,
    need: "admin",
    opts: { method: "PATCH", params: { id: "1", idx: "0" }, body: {} },
  },
  {
    name: "GET /events/{id}/tickets",
    handler: listTickets,
    need: "staff",
    opts: { params: { id: "1" } },
  },
  {
    name: "POST /events/{id}/tickets",
    handler: generate,
    need: "staff",
    opts: { params: { id: "1" }, body: {} },
  },
  {
    name: "POST /events/{id}/tickets/import",
    handler: importTickets,
    need: "admin",
    opts: { params: { id: "1" }, body: {} },
  },
  { name: "GET /events/{id}/stats", handler: stats, need: "staff", opts: { params: { id: "1" } } },
  {
    name: "POST /tickets/{id}/cancel",
    handler: cancel,
    need: "admin",
    opts: { params: { id: ID }, body: {} },
  },
  {
    name: "POST /tickets/{id}/resend",
    handler: resend,
    need: "admin",
    opts: { params: { id: ID }, body: {} },
  },
  {
    name: "POST /tickets/{id}/transfer",
    handler: transfer,
    need: "admin",
    opts: { params: { id: ID }, body: {} },
  },
  { name: "GET /tickets/{id}", handler: getTicket, need: "staff", opts: { params: { id: ID } } },
  {
    name: "GET /events/{id}/tickets/export",
    handler: exportTickets,
    need: "supervisor",
    opts: { params: { id: "1" } },
  },
  {
    name: "GET /events/{id}/devices",
    handler: eventDevices,
    need: "supervisor",
    opts: { params: { id: "1" } },
  },
  {
    name: "GET /events/{id}/conflicts",
    handler: conflicts,
    need: "supervisor",
    opts: { params: { id: "1" } },
  },
  {
    name: "GET /events/{id}/overrides",
    handler: overrides,
    need: "supervisor",
    opts: { params: { id: "1" } },
  },
  {
    name: "POST /events/{id}/admit",
    handler: manualAdmit,
    need: "supervisor",
    opts: { params: { id: "1" }, body: { ticket_id: ID, pin: "12345678" } },
  },
  {
    name: "GET /events/{id}/staff",
    handler: eventStaff,
    need: "admin",
    opts: { params: { id: "1" } },
  },
  {
    name: "PUT /events/{id}/staff/{staffId}",
    handler: setEventStaff,
    need: "admin",
    opts: { method: "PUT", params: { id: "1", staffId: "x" }, body: { assigned: true } },
  },
  {
    name: "PATCH /devices/{id}",
    handler: patchDevice,
    need: "supervisor",
    opts: { method: "PATCH", params: { id: "x" }, body: { gate: "A" } },
  },
  {
    name: "POST /devices/{id}/revoke",
    handler: revokeDevice,
    need: "supervisor",
    opts: { params: { id: "x" }, body: {} },
  },
  {
    name: "POST /scans/{id}/review",
    handler: reviewConflict,
    need: "supervisor",
    opts: { params: { id: "x" }, body: {} },
  },
  {
    name: "POST /devices/enroll (setup)",
    handler: enroll,
    need: "supervisor",
    opts: { body: { event_id: 1, gate: "A", direction: "entry" } },
  },
];

describe.skipIf(!dbAvailable)("auth (MariaDB)", () => {
  let env: TestEnv;
  const staff: Partial<Record<Role, TestStaff>> = {};

  beforeAll(async () => {
    env = await createTestEnv({ COOKIE_SECURE: "true" });
    for (const role of ["staff", "supervisor", "admin"] as const)
      staff[role] = await makeStaff(env, role);
  });
  afterAll(() => env.close());

  describe("role gating", () => {
    for (const ep of staffEndpoints) {
      it(`${ep.name} needs ${ep.need}`, async () => {
        expect((await call(ep.handler, { ...ep.opts })).status, "anonymous").toBe(401);
        for (const role of ["staff", "supervisor", "admin"] as const) {
          const res = await call(ep.handler, { ...ep.opts, staff: staff[role]! });
          if (RANK[role] < RANK[ep.need]) {
            expect(res.status, role).toBe(403);
            expect(res.json.error.code).toBe("forbidden");
          } else {
            expect([401, 403], `${role} must get through`).not.toContain(res.status);
          }
        }
      });
    }

    it("device endpoints reject staff sessions and unknown tokens", async () => {
      for (const [handler, opts] of [
        [syncTickets, {}],
        [syncScans, { body: { scans: [] } }],
      ] as const) {
        expect((await call(handler, { ...opts })).status).toBe(401);
        expect((await call(handler, { ...opts, staff: staff.admin! })).status).toBe(401);
        expect((await call(handler, { ...opts, bearer: "nope" })).status).toBe(401);
        expect(
          (await call(handler, { ...opts, bearer: `${crypto.randomUUID()}.secret` })).status,
        ).toBe(401);
      }
    });

    it("applies a role change immediately", async () => {
      const temp = await makeStaff(env, "admin");
      expect((await call(createStaff, { staff: temp, body: {} })).status).toBe(400); // allowed (bad body)
      await env.handle.db
        .update(mysqlSchema.staff)
        .set({ role: "staff" })
        .where(eq(mysqlSchema.staff.id, temp.id));
      expect((await call(createStaff, { staff: temp, body: {} })).status).toBe(403);
      await env.handle.db.delete(mysqlSchema.staff).where(eq(mysqlSchema.staff.id, temp.id));
      expect((await call(createStaff, { staff: temp, body: {} })).status).toBe(401);
    });
  });

  describe("login", () => {
    const attempt = (name: string, pin: string, ip = "10.0.0.1") =>
      call(login, { body: { name, pin }, headers: { "x-forwarded-for": ip } });

    it("sets an httpOnly, SameSite=Lax, Secure session cookie", async () => {
      const res = await attempt(staff.supervisor!.name, PRIVILEGED_PIN);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ id: staff.supervisor!.id, role: "supervisor" });
      const cookie = res.headers.get("set-cookie")!;
      expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
      for (const attr of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"])
        expect(cookie).toContain(attr);
      expect(res.text).not.toContain("pin_hash");
      expect(res.text).not.toContain(PRIVILEGED_PIN);

      const value = cookie.split(";")[0]!;
      const who = await call(me, { staff: { cookie: value } });
      expect(who.json).toMatchObject({ name: staff.supervisor!.name, role: "supervisor" });
    });

    it("Secure follows COOKIE_SECURE", async () => {
      const plain = await createTestEnv({ COOKIE_SECURE: "false" });
      try {
        const s = await makeStaff(plain, "staff");
        const res = await attempt(s.name, TEST_PIN, "10.0.0.9");
        expect(res.headers.get("set-cookie")).not.toContain("Secure");
      } finally {
        await plain.close();
        setContext(env.ctx); // closing the second env cleared the process-wide context
      }
    });

    it("rejects a wrong PIN and an unknown name the same way", async () => {
      const wrong = await attempt(staff.staff!.name, "not-the-pin", "10.0.0.2");
      const unknown = await attempt("nobody at all", TEST_PIN, "10.0.0.3");
      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        expect(res.json.error.code).toBe("invalid_credentials");
        expect(res.headers.get("set-cookie")).toBeNull();
      }
      expect(wrong.json).toEqual(unknown.json);
    });

    it("rate-limits repeated failures, even for the right PIN afterwards", async () => {
      const ip = "10.0.0.50";
      for (let i = 0; i < 5; i++)
        expect((await attempt(staff.staff!.name, "bad-pin-" + i, ip)).status).toBe(401);
      const blocked = await attempt(staff.staff!.name, TEST_PIN, ip);
      expect(blocked.status).toBe(429);
      // Another client is unaffected.
      expect((await attempt(staff.staff!.name, TEST_PIN, "10.0.0.51")).status).toBe(200);
    });

    it("logout clears the cookie", async () => {
      const res = await call(logout, { body: {} });
      expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    });
  });

  describe("session cookie", () => {
    it("rejects tampered, foreign-signed and expired cookies", async () => {
      const good = staff.staff!.cookie;
      expect((await call(me, { staff: { cookie: good } })).status).toBe(200);
      const [name, value] = good.split("=") as [string, string];
      const [data, mac] = value.split(".") as [string, string];
      const forged = Buffer.from(
        JSON.stringify({ sid: staff.admin!.id, exp: env.clock.now + 999 }),
      ).toString("base64url");
      expect((await call(me, { staff: { cookie: `${name}=${forged}.${mac}` } })).status).toBe(401);
      expect(
        (await call(me, { staff: { cookie: `${name}=${data}.${mac.slice(0, -2)}xx` } })).status,
      ).toBe(401);
      expect((await call(me, { staff: { cookie: `${name}=garbage` } })).status).toBe(401);

      const fresh = `${SESSION_COOKIE}=${createSessionValue(env.ctx, staff.staff!.id)}`;
      env.clock.now += Math.round(env.ctx.config.SESSION_TTL_HOURS * 3600) + 1;
      try {
        expect((await call(me, { staff: { cookie: fresh } })).status).toBe(401);
      } finally {
        env.clock.now -= Math.round(env.ctx.config.SESSION_TTL_HOURS * 3600) + 1;
      }
    });

    it("refuses cross-origin writes and non-JSON bodies", async () => {
      const cross = await call(createStaff, {
        staff: staff.admin!,
        body: {},
        headers: { origin: "https://evil.example", host: "localhost:3000" },
      });
      expect(cross.status).toBe(403);
      expect(cross.json.error.code).toBe("bad_origin");
      const same = await call(createStaff, {
        staff: staff.admin!,
        body: {},
        headers: { origin: "http://localhost:3000", host: "localhost:3000" },
      });
      expect(same.status).toBe(400);
      const form = await call(createStaff, {
        staff: staff.admin!,
        rawBody: "name=x",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      });
      expect(form.status).toBe(415);
    });
  });

  describe("staff creation", () => {
    it("stores an argon2id hash, never the PIN, and refuses duplicates and short PINs", async () => {
      const res = await call(createStaff, {
        staff: staff.admin!,
        body: { name: "Dana", pin: "12345678", role: "supervisor" },
      });
      expect(res.status).toBe(201);
      const [row] = await env.handle.db
        .select()
        .from(mysqlSchema.staff)
        .where(eq(mysqlSchema.staff.id, res.json.id));
      expect(row!.pinHash).toMatch(/^\$argon2id\$/);
      expect(row!.pinHash).not.toContain("12345678");
      expect(
        (
          await call(createStaff, {
            staff: staff.admin!,
            body: { name: "dana", pin: "abcdef", role: "staff" },
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await call(createStaff, {
            staff: staff.admin!,
            body: { name: "Eve", pin: "123", role: "staff" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(createStaff, {
            staff: staff.admin!,
            body: { name: "Eve", pin: "123456", role: "scanner" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(login, {
            body: { name: "Dana", pin: "12345678" },
            headers: { "x-forwarded-for": "10.0.0.77" },
          })
        ).status,
      ).toBe(200);
    });
  });
});
