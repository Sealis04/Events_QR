/**
 * M13: the Staff page's server rules: safety rules, deactivation, admin PIN reset, activity log,
 * and `scripts/create-admin.ts --if-exists reset` reactivation.
 */
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mysqlSchema } from "@events-qr/core";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { POST as changePin } from "../src/app/api/auth/change-pin/route";
import { GET as listEvents } from "../src/app/api/events/route";
import { POST as createEvent } from "../src/app/api/events/route";
import { GET as listStaff, POST as createStaffRoute } from "../src/app/api/staff/route";
import { PATCH as patchStaff } from "../src/app/api/staff/[id]/route";
import { GET as staffLog } from "../src/app/api/staff/log/route";
import { GET as eventStaffList } from "../src/app/api/events/[id]/staff/route";
import { PUT as setEventStaff } from "../src/app/api/events/[id]/staff/[staffId]/route";
import { hashesForEvent } from "../src/server/eventStaff";
import { resetStaff, updateStaff } from "../src/server/staff";
import {
  call,
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  PRIVILEGED_PIN,
  TEST_PIN,
  type TestEnv,
  type TestStaff,
} from "./helpers";

const { staff, auditLog } = mysqlSchema;

describe.skipIf(!dbAvailable)("M13 staff accounts", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });

  const patch = (actor: TestStaff, id: string, body: unknown) =>
    call(patchStaff, { method: "PATCH", staff: actor, params: { id }, body });
  const row = async (id: string) =>
    (await env.handle.db.select().from(staff).where(eq(staff.id, id)))[0]!;
  const logRows = () => env.handle.db.select().from(auditLog).orderBy(asc(auditLog.id));
  const attempt = (name: string, pin: string, extra: Record<string, unknown> = {}) =>
    call(login, { body: { name, pin, ...extra }, headers: { "x-forwarded-for": randomUUID() } });

  /** A fresh world where only `a` and `b` are active admins. */
  async function twoAdmins() {
    await env.handle.db.delete(auditLog);
    await env.handle.db.update(staff).set({ role: "staff" });
    const a = await makeStaff(env, "admin");
    const b = await makeStaff(env, "admin");
    return { a, b };
  }

  describe("safety rules", () => {
    it("an admin cannot deactivate or demote themselves", async () => {
      const { a } = await twoAdmins();
      for (const body of [{ active: false }, { role: "staff" }]) {
        const res = await patch(a, a.id, body);
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe("self_change");
      }
      expect((await row(a.id)).role).toBe("admin");
      expect((await row(a.id)).deactivatedAt).toBeNull();
      expect(await logRows()).toHaveLength(0);
    });

    it("the last active admin cannot be deactivated or demoted (service guard; the route's actor is always an admin)", async () => {
      const { a, b } = await twoAdmins();
      // With two admins, `a` may be demoted by `b`; afterwards `b` is the last one.
      expect((await patch(b, a.id, { role: "supervisor" })).status).toBe(200);
      await env.handle.db.delete(auditLog);
      for (const change of [{ active: false }, { role: "staff" as const }]) {
        await expect(updateStaff(env.ctx, a.id, b.id, change)).rejects.toMatchObject({
          status: 409,
          code: "last_admin",
        });
      }
      expect((await row(b.id)).role).toBe("admin");
      expect((await row(b.id)).deactivatedAt).toBeNull();
      expect(await logRows()).toHaveLength(0);
      // A deactivated admin does not count as active: demoting `b` is still refused after `a` is re-promoted then deactivated.
      await env.handle.db
        .update(staff)
        .set({ role: "admin", deactivatedAt: 1 })
        .where(eq(staff.id, a.id));
      await expect(updateStaff(env.ctx, a.id, b.id, { role: "staff" })).rejects.toMatchObject({
        code: "last_admin",
      });
    });

    it("two admins demoting each other at once: exactly one succeeds", async () => {
      const { a, b } = await twoAdmins();
      const [r1, r2] = await Promise.all([
        patch(a, b.id, { role: "supervisor" }),
        patch(b, a.id, { role: "supervisor" }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      // The loser is either refused as the last admin (409) or, once demoted, no longer an admin (403).
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);
      const roles = [(await row(a.id)).role, (await row(b.id)).role].sort();
      expect(roles).toEqual(["admin", "supervisor"]);
      expect(await logRows()).toHaveLength(1);
    });

    it("names stay unique case-insensitively, deactivated accounts included", async () => {
      const { a, b } = await twoAdmins();
      const gone = await makeStaff(env, "staff", "Former Person");
      expect((await patch(a, gone.id, { active: false })).status).toBe(200);
      for (const name of ["Former Person", "former person", "FORMER PERSON "]) {
        const res = await call(createStaffRoute, {
          staff: b,
          body: { name, pin: TEST_PIN, role: "staff" },
        });
        expect(res.status).toBe(409);
        expect(res.json.error.code).toBe("name_taken");
      }
    });

    it("rejects an unknown account, a bad body and an unchanged role", async () => {
      const { a } = await twoAdmins();
      expect((await patch(a, randomUUID(), { active: false })).status).toBe(404);
      expect((await patch(a, a.id, { role: "root" })).status).toBe(400);
      expect((await patch(a, a.id, { role: "admin", active: false })).status).toBe(400);
      const other = await makeStaff(env, "staff");
      expect((await patch(a, other.id, { role: "staff" })).status).toBe(400);
      expect(await logRows()).toHaveLength(0);
    });

    it("changes a role and logs from and to", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "staff");
      expect((await patch(a, p.id, { role: "supervisor" })).status).toBe(200);
      expect((await row(p.id)).role).toBe("supervisor");
      const [entry] = await logRows();
      expect(entry).toMatchObject({
        action: "staff.role_changed",
        actorStaffId: a.id,
        targetKind: "staff",
        targetId: p.id,
        detail: { from: "staff", to: "supervisor" },
      });
    });
  });

  describe("deactivation", () => {
    it("refuses login like a wrong PIN, 401s the live session, and reactivation restores both", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "staff", "Door Person");
      expect((await attempt(p.name, TEST_PIN)).status).toBe(200);
      expect((await call(me, { staff: p })).status).toBe(200);

      expect((await patch(a, p.id, { active: false })).status).toBe(200);
      const wrongPin = await attempt(p.name, "not-the-pin");
      const deactivated = await attempt(p.name, TEST_PIN);
      expect(deactivated.status).toBe(401);
      expect(deactivated.json).toEqual(wrongPin.json);
      expect((await call(me, { staff: p })).status).toBe(401);
      expect((await call(listEvents, { staff: p })).status).toBe(401);
      // Their account and history are intact.
      expect((await row(p.id)).deactivatedAt).not.toBeNull();

      expect((await patch(a, p.id, { active: true })).status).toBe(200);
      expect((await attempt(p.name, TEST_PIN)).status).toBe(200);
      expect((await call(me, { staff: p })).status).toBe(200);
      expect((await logRows()).map((r) => r.action)).toEqual([
        "staff.deactivated",
        "staff.reactivated",
      ]);
    });

    it("deactivating or reactivating twice is a 409 and writes nothing", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "staff");
      expect((await patch(a, p.id, { active: true })).status).toBe(409);
      expect((await patch(a, p.id, { active: false })).status).toBe(200);
      expect((await patch(a, p.id, { active: false })).status).toBe(409);
      expect(await logRows()).toHaveLength(1);
    });

    it("leaves deactivated and admin-reset staff out of hashesForEvent, and hides them from the event list", async () => {
      const { a } = await twoAdmins();
      const created = await call(createEvent, {
        staff: a,
        body: eventBody(env.clock.now + 3600),
      });
      expect(created.status).toBe(201);
      const eventId = created.json.id as number;
      const ok = await makeStaff(env, "staff", "Still Here");
      const gone = await makeStaff(env, "staff", "Gone Away");
      const reset = await makeStaff(env, "staff", "Reset Me");
      for (const p of [ok, gone, reset])
        await call(setEventStaff, {
          method: "PUT",
          staff: a,
          params: { id: String(eventId), staffId: p.id },
          body: { assigned: true },
        });
      const names = async () => (await hashesForEvent(env.ctx, eventId)).map((s) => s.name);
      expect(await names()).toEqual(
        expect.arrayContaining(["Still Here", "Gone Away", "Reset Me"]),
      );

      await patch(a, gone.id, { active: false });
      await patch(a, reset.id, { reset_pin: "temporary-pin" });
      const after = await names();
      expect(after).toContain("Still Here");
      expect(after).not.toContain("Gone Away");
      expect(after).not.toContain("Reset Me");

      const list = await call(eventStaffList, { staff: a, params: { id: String(eventId) } });
      const listed = (list.json.staff as { name: string }[]).map((s) => s.name);
      expect(listed).toContain("Still Here");
      expect(listed).not.toContain("Gone Away");
      // Add refuses a deactivated account.
      const add = await call(setEventStaff, {
        method: "PUT",
        staff: a,
        params: { id: String(eventId), staffId: gone.id },
        body: { assigned: true },
      });
      expect(add.status).toBe(409);

      await patch(a, gone.id, { active: true });
      expect(await names()).toContain("Gone Away");
    });
  });

  describe("PIN reset by an admin", () => {
    it("sets a temporary PIN; the person can only change it, then logs in normally", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "supervisor", "Forgot Pin");
      const before = (await row(p.id)).pinHash;

      // Rules by role: a supervisor's temporary PIN needs 8+ digits.
      const weak = await patch(a, p.id, { reset_pin: "short" });
      expect(weak.status).toBe(400);
      expect((await row(p.id)).pinHash).toBe(before);
      expect(await logRows()).toHaveLength(0);

      expect((await patch(a, p.id, { reset_pin: "87654321" })).status).toBe(200);
      expect((await row(p.id)).pinReset).toBe("admin");
      // The old PIN is gone; the temporary one logs in but is restricted.
      expect((await attempt(p.name, PRIVILEGED_PIN)).status).toBe(401);
      const session = await attempt(p.name, "87654321");
      expect(session.status).toBe(200);
      expect(session.json.pin_reset).toBe("admin");
      expect((await attempt(p.name, "87654321", { for: "scanner" })).status).toBe(403);
      const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
      expect((await call(listEvents, { staff: { cookie } })).status).toBe(403);
      expect((await call(me, { staff: { cookie } })).json.pin_reset).toBe("admin");

      // Choosing a new PIN clears the flag; the temporary PIN cannot be reused.
      const same = await call(changePin, {
        staff: { cookie },
        body: { current_pin: "87654321", new_pin: "87654321" },
      });
      expect(same.status).toBe(400);
      const done = await call(changePin, {
        staff: { cookie },
        body: { current_pin: "87654321", new_pin: "11223344" },
      });
      expect(done.status).toBe(200);
      expect((await row(p.id)).pinReset).toBeNull();
      expect((await attempt(p.name, "11223344")).json.pin_reset).toBeNull();
      expect((await call(listEvents, { staff: { cookie } })).status).toBe(200);

      const entries = await logRows();
      expect(entries.map((r) => r.action)).toEqual(["staff.pin_reset"]);
      expect(JSON.stringify(entries)).not.toMatch(/87654321|11223344|argon2/);
    });

    it("refuses to reset a deactivated account", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "staff");
      await patch(a, p.id, { active: false });
      expect((await patch(a, p.id, { reset_pin: "temporary-pin" })).status).toBe(409);
    });
  });

  describe("staff list and activity log", () => {
    it("create writes one audit row; the list shows status, events and the log shows names", async () => {
      const { a } = await twoAdmins();
      const res = await call(createStaffRoute, {
        staff: a,
        body: { name: "Brand New", pin: TEST_PIN, role: "staff" },
      });
      expect(res.status).toBe(201);
      // The new PIN works at once, with no forced change.
      expect((await attempt("Brand New", TEST_PIN)).json.pin_reset).toBeNull();
      const entries = await logRows();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: "staff.created",
        actorStaffId: a.id,
        targetId: res.json.id,
        detail: { name: "Brand New", role: "staff" },
      });

      await patch(a, res.json.id, { reset_pin: "temporary-pin" });
      const list = await call(listStaff, { staff: a });
      const brand = list.json.staff.find((s: { id: string }) => s.id === res.json.id);
      expect(brand).toMatchObject({ status: "must_change_pin", role: "staff", events: [] });
      expect(brand.created_at).toBe(entries[0]!.at);
      expect(brand.changed_at).toBeGreaterThanOrEqual(brand.created_at);
      expect(list.json.active_admins).toBe(2);

      const log = await call(staffLog, { staff: a });
      expect(log.json.entries[0]).toMatchObject({
        action: "staff.pin_reset",
        actor: { id: a.id, name: a.name },
        target: { id: res.json.id, name: "Brand New" },
      });
      expect(log.json.entries[1].action).toBe("staff.created");
    });

    it("paginates newest first", async () => {
      const { a } = await twoAdmins();
      const p = await makeStaff(env, "staff");
      for (let i = 0; i < 14; i++) {
        await patch(a, p.id, { active: false });
        await patch(a, p.id, { active: true });
      }
      const first = await call(staffLog, { staff: a });
      expect(first.json.entries).toHaveLength(25);
      expect(first.json.next_before).not.toBeNull();
      const second = await call(staffLog, { staff: a, query: { before: first.json.next_before } });
      expect(second.json.entries).toHaveLength(3);
      expect(second.json.next_before).toBeNull();
      const ids = [...first.json.entries, ...second.json.entries].map((e: { id: number }) => e.id);
      expect(ids).toEqual([...ids].sort((x, y) => y - x));
    });
  });

  describe("scripts/create-admin.ts --if-exists reset", () => {
    it("reactivates a deactivated admin, clears the PIN flag, logs with no actor", async () => {
      const { a, b } = await twoAdmins();
      await patch(a, b.id, { reset_pin: "87654321" });
      await patch(a, b.id, { active: false });
      await env.handle.db.delete(auditLog);

      const out = await resetStaff(env.ctx, { name: b.name, pin: "99887766", role: "admin" });
      expect(out.id).toBe(b.id);
      const after = await row(b.id);
      expect(after.deactivatedAt).toBeNull();
      expect(after.pinReset).toBeNull();
      expect((await attempt(b.name, "99887766")).json.pin_reset).toBeNull();
      const entries = await logRows();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        action: "staff.recovered",
        actorStaffId: null,
        targetId: b.id,
        detail: { was_deactivated: true, to_role: "admin" },
      });
    });
  });
});
