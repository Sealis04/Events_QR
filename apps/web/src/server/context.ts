import { connectDb, dbSettings, type Db } from "./db";
import { loadConfig, requireSetting, type Config } from "./config";
import { parseMasterKey } from "./secrets";
import { Signer } from "./signing";

/** Everything the services need. Built once per process; tests build their own. */
export interface AppContext {
  config: Config;
  db: Db;
  signer: Signer;
  /** Decrypts event keys stored in the database. */
  masterKey: Uint8Array;
  /** Unix seconds. Injectable so tests can move time. */
  now(): number;
}

export const unixNow = (): number => Math.floor(Date.now() / 1000);

const globalKey = Symbol.for("events-qr.context");
type Holder = { [globalKey]?: Promise<AppContext> };

export async function buildContext(config: Config = loadConfig()): Promise<AppContext> {
  const { db } = connectDb(dbSettings(config));
  const signer = await Signer.load(
    requireSetting(config, "SIGNING_KEY_PATH"),
    requireSetting(config, "SIGNING_KEY_PASSPHRASE"),
  );
  const masterKey = parseMasterKey(requireSetting(config, "EVENT_KEY_MASTER"));
  return { config, db, signer, masterKey, now: unixNow };
}

/** Process-wide context (survives dev-server hot reloads). */
export function getContext(): Promise<AppContext> {
  const holder = globalThis as Holder;
  holder[globalKey] ??= buildContext().catch((err) => {
    delete holder[globalKey];
    throw err;
  });
  return holder[globalKey];
}

/** Tests install a context here so route handlers use their database. */
export function setContext(ctx: AppContext | undefined): void {
  const holder = globalThis as Holder;
  if (ctx) holder[globalKey] = Promise.resolve(ctx);
  else delete holder[globalKey];
}
