import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import { verifyPin } from "../src/server/auth";
import { createStaff, findStaffByName, resetStaff } from "../src/server/staff";
import { createTestEnv, dbAvailable, makeStaff, type TestEnv } from "./helpers";

describe.skipIf(!dbAvailable)("staff lookup and reset (scripts/create-admin.ts re-runs)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env?.close();
  });

  const row = async (id: string) =>
    (await env.handle.db.select().from(mysqlSchema.staff).where(eq(mysqlSchema.staff.id, id)))[0]!;

  it("finds a staff member by name, ignoring case and spaces", async () => {
    const s = await makeStaff(env, "supervisor", "Lookup Person");
    expect(await findStaffByName(env.ctx, "  lookup PERSON ")).toEqual({
      id: s.id,
      name: "Lookup Person",
      role: "supervisor",
    });
    expect(await findStaffByName(env.ctx, "nobody")).toBeUndefined();
  });

  it("still refuses a second account with a taken name", async () => {
    await makeStaff(env, "admin", "Taken");
    await expect(
      createStaff(env.ctx, { name: "taken", pin: "12345678", role: "admin" }),
    ).rejects.toMatchObject({ code: "name_taken" });
  });

  it("gives the existing row a new PIN and role and clears a pending reset", async () => {
    const s = await makeStaff(env, "staff", "Promote Me");
    await env.handle.db
      .update(mysqlSchema.staff)
      .set({ pinReset: "rotate" })
      .where(eq(mysqlSchema.staff.id, s.id));

    const out = await resetStaff(env.ctx, { name: "promote me", pin: "87654321", role: "admin" });
    expect(out).toEqual({ id: s.id, name: "Promote Me", role: "admin" });
    const after = await row(s.id);
    expect(after.role).toBe("admin");
    expect(after.pinReset).toBeNull();
    expect(await verifyPin("87654321", after.pinHash)).toBe(true);
  });

  it("refuses a PIN that is too short for the role, and an unknown name", async () => {
    const s = await makeStaff(env, "admin", "Short Pin");
    const before = (await row(s.id)).pinHash;
    await expect(
      resetStaff(env.ctx, { name: "Short Pin", pin: "1234", role: "admin" }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await row(s.id)).pinHash).toBe(before);
    await expect(
      resetStaff(env.ctx, { name: "nobody", pin: "12345678", role: "admin" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
