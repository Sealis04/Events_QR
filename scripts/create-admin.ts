/**
 * Creates a staff member (default role admin), e.g. the first admin.
 *   bun scripts/create-admin.ts --name "Alex" [--role admin|supervisor|staff] [--if-exists fail|skip|reset]
 * The PIN comes from the PIN env var or, if unset, an interactive prompt (never a CLI argument,
 * so it stays out of shell history).
 * If the name is taken (case-insensitive): `fail` (default) exits with code 3 before asking for a
 * PIN, `skip` leaves the account as it is, `reset` gives it the new PIN and role, clears a pending PIN
 * change and reactivates a deactivated account (setup.bat re-runs; also the way back in when no
 * admin can log in). Creation and reset are written to the activity log with no actor.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { STAFF_ROLES } from "../packages/core/src";
import { loadConfig } from "../apps/web/src/server/config";
import { connectDb, dbSettings } from "../apps/web/src/server/db";
import { createStaff, findStaffByName, resetStaff } from "../apps/web/src/server/staff";

/** Exit code for "a staff member with that name already exists" (setup.bat offers its choices on it). */
const NAME_TAKEN = 3;
const IF_EXISTS = ["fail", "skip", "reset"] as const;

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    role: { type: "string", default: "admin" },
    "if-exists": { type: "string", default: "fail" },
  },
});
if (!values.name)
  throw new Error(
    'usage: bun scripts/create-admin.ts --name "Name" [--role admin|supervisor|staff] [--if-exists fail|skip|reset]',
  );
const name = values.name;
const role = STAFF_ROLES.find((r) => r === values.role);
if (!role) throw new Error(`role must be one of ${STAFF_ROLES.join(", ")}`);
const ifExists = IF_EXISTS.find((m) => m === values["if-exists"]);
if (!ifExists) throw new Error(`--if-exists must be one of ${IF_EXISTS.join(", ")}`);

async function askPin(): Promise<string> {
  if (process.env.PIN) return process.env.PIN;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pin = await rl.question("PIN (supervisor and admin: 8+ digits; staff: 6+ characters): ");
  rl.close();
  return pin;
}

const handle = connectDb(dbSettings(loadConfig()));
const ctx = { db: handle.db };
try {
  const existing = await findStaffByName(ctx, name);
  if (!existing) {
    const staff = await createStaff(ctx, { name, pin: await askPin(), role });
    console.log(`created ${staff.role} "${staff.name}" (${staff.id})`);
  } else if (ifExists === "skip") {
    console.log(`kept the existing ${existing.role} "${existing.name}" (${existing.id})`);
  } else if (ifExists === "reset") {
    const staff = await resetStaff(ctx, { name, pin: await askPin(), role });
    console.log(`reset ${staff.role} "${staff.name}" (${staff.id}): new PIN, account active`);
  } else {
    console.error(`a staff member named "${existing.name}" already exists (${existing.role})`);
    process.exitCode = NAME_TAKEN;
  }
} finally {
  await handle.close();
}
