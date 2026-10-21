/** Applies the MariaDB migrations from packages/core/drizzle/mysql. `bun scripts/migrate.ts` */
import { loadConfig } from "../apps/web/src/server/config";
import { connectDb, dbSettings, runMigrations } from "../apps/web/src/server/db";

const handle = connectDb(dbSettings(loadConfig()));
await runMigrations(handle.db);
await handle.close();
console.log("migrations applied");
