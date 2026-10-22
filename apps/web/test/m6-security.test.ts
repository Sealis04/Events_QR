/**
 * M6 part A: longer supervisor/admin PINs with stronger hashing, PIN hashes scoped to an event's
 * staff (Sealis04/Events_QR#8), the cancelled_at backfill (#9) and "Revoke and rotate".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hash } from "@node-rs/argon2";
import { api, hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { needsRehash, PIN_HASH_COST } from "../src/server/auth";
import { POST as login } from "../src/app/api/auth/login/route";
import { GET as me } from "../src/app/api/auth/me/route";
import { POST as changePin } from "../src/app/api/auth/change-pin/route";
import { POST as createStaff } from "../src/app/api/staff/route";
import { GET as listEvents } from "../src/app/api/events/route";
import { GET as vmSync } from "../src/app/api/sync/route";
import { GET as syncMeta } from "../src/app/api/sync/meta/route";
import { GET as eventStaffList } from "../src/app/api/events/[id]/staff/route";
import { PUT as setEventStaff } from "../src/app/api/events/[id]/staff/[staffId]/route";
import { POST as revoke } from "../src/app/api/devices/[id]/revoke/route";
import { POST as vmClaim } from "../src/app/api/claim/route";
import * as hubRoutes from "../src/hub/routes";
import {
  call,
  createTestEnv,
  dbAvailable,
  makeStaff,
  newKey,
  PRIVILEGED_PIN,
  TEST_PIN,
  type TestEnv,
} from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";

const { staff: staffTable, eventStaff, devices, tickets } = mysqlSchema;

describe.skipIf(!dbAvailable)("M6 security: PINs", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(() => env.close());

  const attempt = (name: string, pin: string, extra: Record<string, unknown> = {}) =>
    call(login, { body: { name, pin, ...extra }, headers: { "x-forwarded-for": randomUUID() } });
  const cookieOf = (res: Awaited<ReturnType<typeof attempt>>) =>
    res.headers.get("set-cookie")!.split(";")[0]!;

  it("supervisors and admins need 8+ digits on create; staff keep the 6-character minimum", async () => {
    const admin = await makeStaff(env, "admin");
    const create = (name: string, pin: string, role: string) =>
      call(createStaff, { staff: admin, body: { name, pin, role } });
    for (const role of ["supervisor", "admin"]) {
      expect((await create(`${role}-six`, "123456", role)).status).toBe(400);
      expect((await create(`${role}-seven`, "1234567", role)).status).toBe(400);
      expect((await create(`${role}-letters`, "abcdefgh", role)).status).toBe(400);
      expect((await create(`${role}-ok`, "12345678", role)).status).toBe(201);
    }
    expect((await create("plain-six", "abcdef", "staff")).status).toBe(201);
    expect((await create("plain-five", "abcde", "staff")).status).toBe(400);
  });

  it("hashes use the slower argon2id settings", async () => {
    const admin = await makeStaff(env, "admin");
    await call(createStaff, {
      staff: admin,
      body: { name: "Hash Hal", pin: "87654321", role: "supervisor" },
    });
    const [row] = await env.handle.db
      .select()
      .from(staffTable)
      .where(eq(staffTable.name, "Hash Hal"));
    expect(row!.pinHash).toContain(`m=${PIN_HASH_COST.memoryCost},t=${PIN_HASH_COST.timeCost}`);
    expect(needsRehash(row!.pinHash)).toBe(false);
    const weak = await hash("x", { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    expect(needsRehash(weak)).toBe(true);
  });

  async function legacy(
    role: "staff" | "supervisor" | "admin",
    pin: string,
    reset?: "weak" | "rotate",
  ) {
    const id = randomUUID();
    const name = `${role}-${id.slice(0, 6)}`;
    const pinHash = await hash(pin, {
      algorithm: 2,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    await env.handle.db
      .insert(staffTable)
      .values({ id, name, pinHash, role, pinReset: reset ?? null });
    return { id, name };
  }
  const rowOf = async (id: string) =>
    (await env.handle.db.select().from(staffTable).where(eq(staffTable.id, id)))[0]!;

  it("a supervisor with a short PIN is flagged at login and nothing but change-pin works until it is changed", async () => {
    const s = await legacy("supervisor", "123456");
    const res = await attempt(s.name, "123456");
    expect(res.status).toBe(200);
    expect(res.json.pin_reset).toBe("weak");
    const session = { cookie: cookieOf(res) };

    expect((await call(me, { staff: session })).json.pin_reset).toBe("weak");
    const blocked = await call(listEvents, { staff: session });
    expect(blocked.status).toBe(403);
    expect(blocked.json.error.code).toBe("pin_change_required");

    const short = await call(changePin, {
      staff: session,
      body: { current_pin: "123456", new_pin: "654321" },
    });
    expect(short.status).toBe(400);
    const wrong = await call(changePin, {
      staff: session,
      body: { current_pin: "nope", new_pin: "87654321" },
    });
    expect(wrong.status).toBe(401);
    const same = await call(changePin, {
      staff: session,
      body: { current_pin: "123456", new_pin: "123456" },
    });
    expect(same.status).toBe(400);
    const ok = await call(changePin, {
      staff: session,
      body: { current_pin: "123456", new_pin: "87654321" },
    });
    expect(ok.status).toBe(200);

    expect((await call(listEvents, { staff: session })).status).toBe(200);
    expect((await attempt(s.name, "123456")).status).toBe(401);
    const again = await attempt(s.name, "87654321");
    expect(again.json.pin_reset).toBeNull();
    expect(needsRehash((await rowOf(s.id)).pinHash)).toBe(false);
  });

  it("an existing supervisor whose PIN already has 8+ digits is cleared and re-hashed at login", async () => {
    const s = await legacy("admin", "11223344", "weak");
    const res = await attempt(s.name, "11223344");
    expect(res.json.pin_reset).toBeNull();
    const row = await rowOf(s.id);
    expect(row.pinReset).toBeNull();
    expect(needsRehash(row.pinHash)).toBe(false);
    expect((await call(listEvents, { staff: { cookie: cookieOf(res) } })).status).toBe(200);
  });

  it("a privileged account whose PIN fails the rule gets flagged even if nobody flagged it", async () => {
    const s = await legacy("supervisor", "short1");
    expect((await attempt(s.name, "short1")).json.pin_reset).toBe("weak");
    expect((await rowOf(s.id)).pinReset).toBe("weak");
  });

  it("plain staff with an old hash are re-hashed at login and are never flagged for length", async () => {
    const s = await legacy("staff", "abcdef");
    const res = await attempt(s.name, "abcdef");
    expect(res.json.pin_reset).toBeNull();
    expect(needsRehash((await rowOf(s.id)).pinHash)).toBe(false);
  });

  it("a rotate flag needs a different PIN, and a phone login is refused (no restricted session for phones)", async () => {
    const s = await legacy("supervisor", "99887766", "rotate");
    const phone = await attempt(s.name, "99887766", { for: "scanner" });
    expect(phone.status).toBe(403);
    expect(phone.json.error.code).toBe("pin_change_required");
    expect(phone.headers.get("set-cookie")).toBeNull();

    const res = await attempt(s.name, "99887766");
    expect(res.json.pin_reset).toBe("rotate");
    const session = { cookie: cookieOf(res) };
    const same = await call(changePin, {
      staff: session,
      body: { current_pin: "99887766", new_pin: "99887766" },
    });
    expect(same.status).toBe(400);
    expect(
      (
        await call(changePin, {
          staff: session,
          body: { current_pin: "99887766", new_pin: "11112222" },
        })
      ).status,
    ).toBe(200);
    expect((await rowOf(s.id)).pinReset).toBeNull();
    expect((await attempt(s.name, "11112222", { for: "scanner" })).status).toBe(200);
  });

  it("the migration flags existing supervisors and admins, not plain staff", async () => {
    const sup = await legacy("supervisor", "12345678");
    const adm = await legacy("admin", "12345678");
    const plain = await legacy("staff", "abcdef");
    const file = resolve(
      import.meta.dirname,
      "../../../packages/core/drizzle/mysql/0005_backfill_cancelled_at.sql",
    );
    const flagging = readFileSync(file, "utf8").split("--> statement-breakpoint")[1]!;
    await env.handle.db.execute(sql.raw(flagging.replace(/^--.*$/gm, "")));
    expect((await rowOf(sup.id)).pinReset).toBe("weak");
    expect((await rowOf(adm.id)).pinReset).toBe("weak");
    expect((await rowOf(plain.id)).pinReset).toBeNull();
    // Their 8-digit PIN already meets the rule, so the next login clears the flag.
    expect((await attempt(sup.name, "12345678")).json.pin_reset).toBeNull();
  });

  it("an override at the VM needs a supervisor who is not waiting to change their PIN", async () => {
    const sup = await legacy("supervisor", "55667788", "rotate");
    const phone = await makeStaff(env, "admin");
    expect(sup.id).toBeTruthy();
    expect(phone.id).toBeTruthy();
    // The claim route itself is covered in hub-claim/issuance suites; here only the flag matters.
    const body = {
      scan_id: randomUUID(),
      ticket_id: "00".repeat(16),
      device_id: randomUUID(),
      staff_id: sup.id,
      gate: "x",
      scanned_at: 1,
      override: true,
    };
    const res = await call(vmClaim, { bearer: "nope", body });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)(
  "M6 security: hashes only for the event's staff (#8), backfill (#9), revoke and rotate",
  () => {
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

    const syncNames = async (token: string) => {
      const res = await call(vmSync, { bearer: token });
      expect(res.status).toBe(200);
      return (api.hubSyncResponse.parse(res.json).staff as { name: string }[]).map((s) => s.name);
    };
    const metaStaff = async () => {
      const res = await call(syncMeta, { bearer: hubToken });
      return api.syncMetaResponse.parse(res.json).staff.map((s) => s.name);
    };
    let hubToken: string;
    beforeAll(async () => {
      const { getLink } = await import("../src/hub/state");
      hubToken = getLink(w.hub)!.token;
    });

    it("phones and the hub get hashes for assigned staff only; removal and event end take them away", async () => {
      const phone = await w.enrolAtVm("Gate A", "entry");
      const outsider = await makeStaff(env, "staff", "Outsider Olly");
      const issuer = await makeStaff(env, "staff", "Issuer Ivy");
      const added = await makeStaff(env, "supervisor", "Added Abe");

      let names = await syncNames(phone.token);
      expect(names).not.toContain(outsider.name);
      expect(names).not.toContain(issuer.name);

      // Issuing a ticket makes someone part of the event.
      const t = await call(generate, {
        staff: issuer,
        params: { id: String(w.eventId) },
        body: { idempotency_key: newKey(), ticket_type: 0, holder_name: "X" },
      });
      expect(t.status).toBe(201);
      names = await syncNames(phone.token);
      expect(names).toContain(issuer.name);
      expect(await metaStaff()).toContain(issuer.name);

      // Explicit add.
      const put = (staffId: string, assigned: boolean | null, who = w.admin) =>
        call(setEventStaff, {
          staff: who,
          params: { id: String(w.eventId), staffId },
          body: { assigned },
        });
      expect((await put(added.id, true)).status).toBe(200);
      expect(await syncNames(phone.token)).toContain(added.name);

      // Removal beats having issued tickets, and the next sync no longer carries the hash.
      expect((await put(issuer.id, false)).status).toBe(200);
      names = await syncNames(phone.token);
      expect(names).not.toContain(issuer.name);
      expect(await metaStaff()).not.toContain(issuer.name);
      expect((await put(issuer.id, null)).status).toBe(200);
      expect(await syncNames(phone.token)).toContain(issuer.name);

      // The hub drops the hash it had (the row stays, empty) and stops serving it to phones.
      await w.pull();
      const hubStaff = sqliteSchema.staff;
      expect(
        w.hub.db.select().from(hubStaff).where(eq(hubStaff.id, added.id)).get()!.pinHash,
      ).toMatch(/^\$argon2id/);
      await put(added.id, false);
      await w.pull();
      expect(w.hub.db.select().from(hubStaff).where(eq(hubStaff.id, added.id)).get()!.pinHash).toBe(
        "",
      );
      const hubPhone = await w.enrolAtHub("Gate A", "entry");
      const hubSync = await call(hubRoutes.sync, { bearer: hubPhone.token });
      expect((hubSync.json.staff as { name: string }[]).map((s) => s.name)).not.toContain(
        added.name,
      );
      // ...and nobody can log in with it there.
      expect(
        (await call(hubRoutes.login, { body: { name: added.name, pin: PRIVILEGED_PIN } })).status,
      ).toBe(401);

      // After the event ends nothing is served.
      env.clock.now += 7 * 86400;
      expect(await syncNames(phone.token)).toEqual([]);
      expect(await metaStaff()).toEqual([]);
      env.clock.now -= 7 * 86400;
    });

    it("the staff list and assignment are admin-only", async () => {
      const params = { id: String(w.eventId) };
      expect((await call(eventStaffList, { params, staff: w.supervisor })).status).toBe(403);
      expect((await call(eventStaffList, { params, staff: w.admin })).status).toBe(200);
      const res = await call(setEventStaff, {
        params: { ...params, staffId: w.staff.id },
        body: { assigned: true },
        staff: w.supervisor,
      });
      expect(res.status).toBe(403);
      const missing = await call(setEventStaff, {
        params: { ...params, staffId: randomUUID() },
        body: { assigned: true },
        staff: w.admin,
      });
      expect(missing.status).toBe(404);
      const list = (await call(eventStaffList, { params, staff: w.admin })).json.staff as {
        id: string;
        assignment: string | null;
      }[];
      expect(list.find((s) => s.id === w.supervisor.id)!.assignment).toBe("added");
    });

    it("staff who must change their PIN are not sent to phones or the hub", async () => {
      const phone = await w.enrolAtVm("Gate B", "entry");
      const flagged = await makeStaff(env, "supervisor", "Flagged Fay");
      await env.handle.db
        .insert(eventStaff)
        .values({ eventId: w.eventId, staffId: flagged.id, assigned: true });
      expect(await syncNames(phone.token)).toContain(flagged.name);
      await env.handle.db
        .update(staffTable)
        .set({ pinReset: "weak" })
        .where(eq(staffTable.id, flagged.id));
      expect(await syncNames(phone.token)).not.toContain(flagged.name);
      expect(await metaStaff()).not.toContain(flagged.name);
    });

    it("backfill: cancelled tickets get cancelled_at = updated_at, once", async () => {
      const t = await w.makeTicket(0, "Old cancelled");
      await w.cancel(t.id);
      const id = Buffer.from(hexToBytes(t.id));
      await env.handle.db
        .update(tickets)
        .set({ cancelledAt: null, updatedAt: 1_700_000_000 })
        .where(eq(tickets.id, id));
      const live = await w.makeTicket(0, "Still valid");

      const file = resolve(
        import.meta.dirname,
        "../../../packages/core/drizzle/mysql/0005_backfill_cancelled_at.sql",
      );
      // Only the first statement (the backfill); the second flags every privileged account.
      const statements = readFileSync(file, "utf8").split("--> statement-breakpoint").slice(0, 1);
      const run = async () => {
        for (const s of statements) await env.handle.db.execute(sql.raw(s.replace(/^--.*$/gm, "")));
      };
      await run();
      const row = (await env.handle.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
      expect(row.cancelledAt).toBe(1_700_000_000);
      expect(row.updatedAt).toBe(1_700_000_000);
      const other = (
        await env.handle.db
          .select()
          .from(tickets)
          .where(eq(tickets.id, Buffer.from(hexToBytes(live.id))))
      )[0]!;
      expect(other.cancelledAt).toBeNull();
      await run(); // idempotent
      expect(
        (await env.handle.db.select().from(tickets).where(eq(tickets.id, id)))[0]!.cancelledAt,
      ).toBe(1_700_000_000);
    });

    it("Revoke and rotate: the device is revoked and everyone tied to the event must pick a new PIN", async () => {
      const lost = await w.enrolAtVm("Gate A", "entry");
      const other = await w.enrolAtVm("Gate B", "entry"); // enrolled before the supervisor is flagged
      const bystander = await makeStaff(env, "supervisor", "Bystander Bo"); // never on this event
      const body = { rotate: true };
      // Only a supervisor may do it.
      expect((await call(revoke, { params: { id: lost.id }, body, staff: w.staff })).status).toBe(
        403,
      );
      const res = await call(revoke, { params: { id: lost.id }, body, staff: w.supervisor });
      expect(res.status).toBe(200);
      expect(res.json.rotated_staff.map((s: { id: string }) => s.id)).toEqual(
        expect.arrayContaining([w.admin.id, w.supervisor.id, w.staff.id]),
      );

      const [dev] = await env.handle.db.select().from(devices).where(eq(devices.id, lost.id));
      expect(dev!.revoked).toBe(true);
      expect((await call(vmSync, { bearer: lost.token })).status).toBe(401);

      const flagged = await env.handle.db
        .select()
        .from(staffTable)
        .where(and(eq(staffTable.pinReset, "rotate")));
      expect(flagged.map((s) => s.id)).toEqual(
        expect.arrayContaining([w.admin.id, w.supervisor.id, w.staff.id]),
      );
      expect(flagged.map((s) => s.id)).not.toContain(bystander.id);

      // Their hashes stop going to phones until they have changed their PIN.
      expect(await syncNames(other.token)).toEqual([]);

      // A flagged supervisor logs in, changes the PIN, and is back in the list.
      const session = await call(login, {
        body: { name: w.supervisor.name, pin: PRIVILEGED_PIN },
        headers: { "x-forwarded-for": "9.9.9.9" },
      });
      expect(session.json.pin_reset).toBe("rotate");
      const cookie = { cookie: session.headers.get("set-cookie")!.split(";")[0]! };
      expect(
        (
          await call(changePin, {
            staff: cookie,
            body: { current_pin: PRIVILEGED_PIN, new_pin: "24681357" },
          })
        ).status,
      ).toBe(200);
      expect(await syncNames(other.token)).toEqual([w.supervisor.name]);
    });

    it("revoking without rotate leaves PINs alone", async () => {
      const phone = await w.enrolAtVm("Gate A", "entry");
      await env.handle.db.update(staffTable).set({ pinReset: null });
      const res = await call(revoke, { params: { id: phone.id }, body: {}, staff: w.supervisor });
      expect(res.status).toBe(200);
      expect(res.json.rotated_staff).toEqual([]);
      const flagged = await env.handle.db
        .select()
        .from(staffTable)
        .where(eq(staffTable.pinReset, "rotate"));
      expect(flagged).toEqual([]);
    });
  },
);

void TEST_PIN;
