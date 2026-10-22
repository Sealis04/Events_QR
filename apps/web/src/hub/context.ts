import { loadConfig, type Config } from "../server/config";
import { openHubDb, type HubDb, type SqliteHandle } from "./db";

/** Everything the hub services need. No signing key, no MariaDB: a hub can verify and claim, never mint. */
const unixNow = (): number => Math.floor(Date.now() / 1000);

export interface HubContext {
  config: Config;
  db: HubDb;
  sqlite: SqliteHandle;
  /** Unix seconds. Injectable so tests can move time. */
  now(): number;
  /** `fetch` used towards the VM. Tests plug in a function that calls the VM's routes directly. */
  vmFetch?: typeof fetch;
}

const globalKey = Symbol.for("events-qr.hub-context");
type Holder = { [globalKey]?: Promise<HubContext> };

export async function buildHubContext(
  config: Config = loadConfig(),
  options: { migrate?: boolean } = {},
): Promise<HubContext> {
  const { db, sqlite } = await openHubDb(config.HUB_DB_PATH, options);
  return { config, db, sqlite, now: unixNow };
}

/** Process-wide context (survives dev-server hot reloads). */
export function getHubContext(): Promise<HubContext> {
  const holder = globalThis as Holder;
  holder[globalKey] ??= buildHubContext().catch((err) => {
    delete holder[globalKey];
    throw err;
  });
  return holder[globalKey];
}

/** Tests install a context here so route handlers use their database. */
export function setHubContext(ctx: HubContext | undefined): void {
  const holder = globalThis as Holder;
  if (ctx) holder[globalKey] = Promise.resolve(ctx);
  else delete holder[globalKey];
}

/** Runs `fn` in a `BEGIN IMMEDIATE` transaction: the hub's atomic section (docs/spec.md "The claim"). */
export function immediate<T>(ctx: HubContext, fn: () => T): T {
  return ctx.sqlite.transaction(fn).immediate();
}
