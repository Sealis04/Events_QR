/**
 * Creates a staff member (default role admin), e.g. the first admin.
 *   bun scripts/create-admin.ts --name "Alex" [--role admin|supervisor|staff]
 * The PIN comes from the PIN env var or, if unset, an interactive prompt (never a CLI argument,
 * so it stays out of shell history).
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { STAFF_ROLES } from "../packages/core/src";
import { loadConfig } from "../apps/web/src/server/config";
import { connectDb, dbSettings } from "../apps/web/src/server/db";
import { createStaff } from "../apps/web/src/server/staff";

const { values } = parseArgs({
  options: { name: { type: "string" }, role: { type: "string", default: "admin" } },
});
if (!values.name)
  throw new Error(
    'usage: bun scripts/create-admin.ts --name "Name" [--role admin|supervisor|staff]',
  );
const role = STAFF_ROLES.find((r) => r === values.role);
if (!role) throw new Error(`role must be one of ${STAFF_ROLES.join(", ")}`);

let pin = process.env.PIN;
if (!pin) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  pin = await rl.question("PIN (6+ characters): ");
  rl.close();
}

const handle = connectDb(dbSettings(loadConfig()));
const staff = await createStaff({ db: handle.db }, { name: values.name, pin, role });
await handle.close();
console.log(`created ${staff.role} "${staff.name}" (${staff.id})`);
