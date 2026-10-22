/** Applies the SQLite migrations to the hub database (HUB_DB_PATH). `bun scripts/hub-migrate.ts` */
import { loadConfig } from "../apps/web/src/server/config";
import { openHubDb } from "../apps/web/src/hub/db";

const config = loadConfig();
const hub = await openHubDb(config.HUB_DB_PATH, { migrate: true });
hub.close();
console.log(`hub migrations applied to ${config.HUB_DB_PATH}`);
