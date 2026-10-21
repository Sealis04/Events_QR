import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { hashPin, MIN_PIN_LENGTH, type StaffRole } from "./auth";
import { badRequest, conflict } from "./http";

const { staff } = mysqlSchema;

export async function createStaff(
  ctx: Pick<AppContext, "db">,
  input: { name: string; pin: string; role: StaffRole },
): Promise<{ id: string; name: string; role: StaffRole }> {
  const name = input.name.trim();
  if (!name) throw badRequest("name is required");
  if (input.pin.length < MIN_PIN_LENGTH)
    throw badRequest(`PIN must be at least ${MIN_PIN_LENGTH} characters`);
  const [existing] = await ctx.db
    .select({ id: staff.id })
    .from(staff)
    .where(sql`LOWER(${staff.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (existing) throw conflict("name_taken", "a staff member with that name already exists");
  const id = randomUUID();
  await ctx.db
    .insert(staff)
    .values({ id, name, pinHash: await hashPin(input.pin), role: input.role });
  return { id, name, role: input.role };
}
