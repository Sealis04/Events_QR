import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { hashPin, pinProblem, type StaffRole } from "./auth";
import { badRequest, conflict } from "./http";

const { staff } = mysqlSchema;

export async function createStaff(
  ctx: Pick<AppContext, "db">,
  input: { name: string; pin: string; role: StaffRole },
): Promise<{ id: string; name: string; role: StaffRole }> {
  const name = input.name.trim();
  if (!name) throw badRequest("name is required");
  const problem = pinProblem(input.role, input.pin);
  if (problem) throw badRequest(problem);
  if (await findStaffByName(ctx, name))
    throw conflict("name_taken", "a staff member with that name already exists");
  const id = randomUUID();
  await ctx.db
    .insert(staff)
    .values({ id, name, pinHash: await hashPin(input.pin), role: input.role });
  return { id, name, role: input.role };
}

/** The staff member with this name, matched case-insensitively (as at login and in `createStaff`). */
export async function findStaffByName(
  ctx: Pick<AppContext, "db">,
  name: string,
): Promise<{ id: string; name: string; role: string } | undefined> {
  const [row] = await ctx.db
    .select({ id: staff.id, name: staff.name, role: staff.role })
    .from(staff)
    .where(sql`LOWER(${staff.name}) = ${name.trim().toLowerCase()}`)
    .limit(1);
  return row;
}

/**
 * Gives an existing staff member a new PIN and role and clears any pending PIN reset, e.g. when
 * `scripts/create-admin.ts --if-exists reset` is re-run for an admin whose PIN is unknown. The row
 * is kept: tickets, scans and event assignments still point at it.
 */
export async function resetStaff(
  ctx: Pick<AppContext, "db">,
  input: { name: string; pin: string; role: StaffRole },
): Promise<{ id: string; name: string; role: StaffRole }> {
  const problem = pinProblem(input.role, input.pin);
  if (problem) throw badRequest(problem);
  const row = await findStaffByName(ctx, input.name);
  if (!row) throw badRequest("no staff member with that name");
  await ctx.db
    .update(staff)
    .set({ pinHash: await hashPin(input.pin), role: input.role, pinReset: null })
    .where(eq(staff.id, row.id));
  return { id: row.id, name: row.name, role: input.role };
}
