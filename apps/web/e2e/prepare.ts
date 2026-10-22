/**
 * Creates the throwaway e2e database with the real migrations, a signing key, three staff accounts
 * and one event. Runs before the server starts (see playwright.config.ts).
 */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection } from "mysql2/promise";
import { loadConfig, requireSetting } from "../src/server/config";
import { buildContext } from "../src/server/context";
import { runMigrations } from "../src/server/db";
import { createEvent } from "../src/server/events";
import { createSigningKeyFile } from "../src/server/signing";
import { createStaff } from "../src/server/staff";
import { E2E_PIN } from "./constants";

const config = loadConfig();
const keyPath = requireSetting(config, "SIGNING_KEY_PATH");
rmSync(dirname(keyPath), { recursive: true, force: true });
mkdirSync(dirname(keyPath), { recursive: true });
await createSigningKeyFile(keyPath, requireSetting(config, "SIGNING_KEY_PASSPHRASE"));

const admin = await createConnection({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
});
await admin.query(`DROP DATABASE IF EXISTS \`${config.DB_NAME}\``);
await admin.query(`CREATE DATABASE \`${config.DB_NAME}\` CHARACTER SET utf8mb4`);
await admin.end();

const ctx = await buildContext(config);
await runMigrations(ctx.db);
for (const [name, role] of [
  ["e2e-admin", "admin"],
  ["e2e-super", "supervisor"],
  ["e2e-staff", "staff"],
] as const) {
  await createStaff(ctx, { name, role, pin: E2E_PIN });
}
const now = ctx.now();
await createEvent(ctx, {
  name: "E2E Fest",
  timezone: "UTC",
  starts_at: now - 3600,
  ends_at: now + 6 * 3600,
  gates: ["Gate A", "Gate B"],
  ticket_types: [
    { idx: 0, name: "GA" },
    { idx: 1, name: "VIP", entry_rule: { mode: "limited", max_admits: 3 } },
  ],
});
console.log("e2e: database ready");
process.exit(0);
