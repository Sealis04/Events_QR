import { eq } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import { hashPin, needsRehash, pinProblem, verifyPin, type AuthedStaff } from "./auth";
import type { AppContext } from "./context";
import { badRequest, HttpError } from "./http";

const { staff } = mysqlSchema;

type StaffRow = typeof staff.$inferSelect;
export type PinReset = "weak" | "rotate" | null;

/**
 * Called after a correct PIN at login. Brings the stored record up to date and says whether this
 * person must still choose a new PIN: a flagged `weak` PIN is cleared when the one just typed
 * already meets the rule (it is then re-hashed with the current settings); a privileged role whose
 * PIN fails the rule gets flagged; a `rotate` flag stays until `changePin`.
 */
export async function settleLogin(ctx: AppContext, row: StaffRow, pin: string): Promise<PinReset> {
  let reset: PinReset = row.pinReset === "weak" || row.pinReset === "rotate" ? row.pinReset : null;
  const meetsRule = pinProblem(row.role, pin) === undefined;
  if (reset === "weak" && meetsRule) reset = null;
  else if (reset === null && !meetsRule) reset = "weak";

  const set: Partial<typeof staff.$inferInsert> = {};
  if (reset !== row.pinReset) set.pinReset = reset;
  if (needsRehash(row.pinHash)) set.pinHash = await hashPin(pin);
  if (Object.keys(set).length) await ctx.db.update(staff).set(set).where(eq(staff.id, row.id));
  return reset;
}

/** `POST /api/auth/change-pin`: the new PIN must meet the role's rule and differ from the old one. */
export async function changePin(
  ctx: AppContext,
  who: AuthedStaff,
  currentPin: string,
  newPin: string,
): Promise<void> {
  const [row] = await ctx.db.select().from(staff).where(eq(staff.id, who.id)).limit(1);
  if (!row || !(await verifyPin(currentPin, row.pinHash)))
    throw new HttpError(401, "invalid_credentials", "current PIN is wrong");
  const problem = pinProblem(row.role, newPin);
  if (problem) throw badRequest(problem);
  if (newPin === currentPin) throw badRequest("choose a PIN you have not used before");
  await ctx.db
    .update(staff)
    .set({ pinHash: await hashPin(newPin), pinReset: null })
    .where(eq(staff.id, row.id));
}
