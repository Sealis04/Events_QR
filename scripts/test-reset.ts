/**
 * Resets the TEST copy (docker/compose.test.yml, docs/test-setup.md) to a known state:
 * empties its database, re-applies the migrations, creates the three test accounts and seeds the
 * "Dress rehearsal" event with its 50 tickets and printable sheet.
 *
 *   bun scripts/test-reset.ts --yes [--out test-sheet.html]
 *
 * Refuses to run unless all of these hold, so it can never empty production:
 * - `--yes` is passed;
 * - `INSTANCE_LABEL` is set (the test copy sets it; production must not);
 * - `DB_NAME` contains "test";
 * - `PUBLIC_URL` is not `PRODUCTION_URL` (same rule as scripts/rehearsal-seed.ts).
 *
 * The account PINs come from TEST_ADMIN_PIN, TEST_SUPERVISOR_PIN and TEST_STAFF_PIN, or the
 * defaults below (fine for a test copy: it holds no real tickets).
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { StaffRole } from "../apps/web/src/server/auth";
import { loadConfig } from "../apps/web/src/server/config";
import { buildContext } from "../apps/web/src/server/context";
import { connectDb, dbSettings, runMigrations, type DbHandle } from "../apps/web/src/server/db";
import { createStaff } from "../apps/web/src/server/staff";
import { EVENT_NAME, refusal, renderSheet, seedRehearsal, sheetEntries } from "./rehearsal-seed";

export const TEST_ACCOUNTS: { name: string; role: StaffRole; pinEnv: string; pin: string }[] = [
  { name: "Test Admin", role: "admin", pinEnv: "TEST_ADMIN_PIN", pin: "20262026" },
  { name: "Test Supervisor", role: "supervisor", pinEnv: "TEST_SUPERVISOR_PIN", pin: "30303030" },
  { name: "Test Staff", role: "staff", pinEnv: "TEST_STAFF_PIN", pin: "404040" },
];

/** Why the reset must not run against this environment, or undefined if it may. */
export function resetRefusal(opts: {
  yes: boolean;
  env: Record<string, string | undefined>;
}): string | undefined {
  if (!opts.yes) return "pass --yes to confirm that this is the test copy";
  if (!opts.env.INSTANCE_LABEL?.trim())
    return "INSTANCE_LABEL is not set, so this does not look like the test copy (see docs/test-setup.md)";
  const db = opts.env.DB_NAME ?? "events_qr";
  if (!/test/i.test(db)) return `DB_NAME "${db}" does not contain "test"`;
  return refusal({ yes: true, env: opts.env });
}

/** Drops every table in the current database, including drizzle's migration journal. */
export async function dropAllTables(pool: DbHandle["pool"]): Promise<number> {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    const names = (rows as Record<string, string>[])
      .map((r) => Object.values(r)[0])
      .filter((n): n is string => typeof n === "string");
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    for (const name of names) await conn.query(`DROP TABLE \`${name.replace(/`/g, "``")}\``);
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    return names.length;
  } finally {
    conn.release();
  }
}

export function accountPins(env: Record<string, string | undefined>) {
  return TEST_ACCOUNTS.map((a) => ({ ...a, pin: env[a.pinEnv]?.trim() || a.pin }));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      out: { type: "string", default: "test-sheet.html" },
    },
  });
  const why = resetRefusal({ yes: values.yes ?? false, env: process.env });
  if (why) {
    console.error(`refusing to run: ${why}`);
    process.exit(1);
  }

  const config = loadConfig();
  const handle = connectDb(dbSettings(config));
  const dropped = await dropAllTables(handle.pool);
  await runMigrations(handle.db);
  const accounts = accountPins(process.env);
  let adminId = "";
  for (const a of accounts) {
    const created = await createStaff(
      { db: handle.db },
      { name: a.name, pin: a.pin, role: a.role },
    );
    if (a.role === "admin") adminId = created.id;
  }
  await handle.close();

  const ctx = await buildContext(config);
  const eventId = await seedRehearsal(ctx, { id: adminId, role: "admin" });
  const entries = await sheetEntries(ctx, eventId);
  writeFileSync(values.out!, renderSheet(entries));

  console.log(`test copy reset: dropped ${dropped} tables, migrations applied`);
  for (const a of accounts) console.log(`  ${a.role.padEnd(10)} "${a.name}"  PIN ${a.pin}`);
  console.log(
    `"${EVENT_NAME}" is event ${eventId}: ${entries.length} tickets, sheet at ${values.out}`,
  );
  console.log(
    "Next: re-enrol the test hub (scripts/hub-enroll.ts) and set up the test phones again; old device tokens no longer exist.",
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
