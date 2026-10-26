/** Creates the hub's empty SQLite file with the real migrations, before the hub server starts. */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/server/config";
import { openHubDb } from "../src/hub/db";

const config = loadConfig();
const dir = dirname(config.HUB_DB_PATH);
mkdirSync(dir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(config.HUB_DB_PATH + suffix, { force: true });
// A self-signed certificate valid for 90 days: the hub reports its expiry (hub setup page, step 3).
if (config.HUB_CERT_PATH) {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "/dev/null",
      "-out",
      config.HUB_CERT_PATH,
      "-days",
      "90",
      "-subj",
      "/CN=hub.e2e.test",
    ],
    { stdio: "ignore" },
  );
}
const hub = await openHubDb(config.HUB_DB_PATH, { migrate: true });
hub.close();
console.log("e2e: hub database ready");
process.exit(0);
