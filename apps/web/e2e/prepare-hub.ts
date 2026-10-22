/** Creates the hub's empty SQLite file with the real migrations, before the hub server starts. */
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../src/server/config";
import { openHubDb } from "../src/hub/db";

const config = loadConfig();
const dir = dirname(config.HUB_DB_PATH);
mkdirSync(dir, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) rmSync(config.HUB_DB_PATH + suffix, { force: true });
const hub = await openHubDb(config.HUB_DB_PATH, { migrate: true });
hub.close();
console.log("e2e: hub database ready");
process.exit(0);
