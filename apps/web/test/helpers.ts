/**
 * Integration-test harness: every test file gets its own throwaway MariaDB database, migrated with
 * the real migrations, plus an AppContext wired to it. If no MariaDB is reachable the suites skip
 * with a message (they run in this sandbox: see scripts/ccr-session-init.sh).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createConnection } from "mysql2/promise";
import { mysqlSchema, generateEventKey, generateSigningKeyPair } from "@events-qr/core";
import { createSessionValue, hashPin, SESSION_COOKIE, type StaffRole } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import { setContext, type AppContext } from "../src/server/context";
import { connectDb, runMigrations, type DbHandle } from "../src/server/db";
import { decryptEventKey, sha256Hex } from "../src/server/secrets";
import { Signer } from "../src/server/signing";

const baseEnv = process.env;
const admin = {
  host: baseEnv.DB_HOST ?? "127.0.0.1",
  port: Number(baseEnv.DB_PORT ?? 3306),
  user: baseEnv.TEST_DB_ADMIN_USER ?? baseEnv.DB_USER ?? "events_qr",
  password: baseEnv.TEST_DB_ADMIN_PASSWORD ?? baseEnv.DB_PASSWORD ?? "",
};

async function reachable(): Promise<string | undefined> {
  try {
    const conn = await createConnection({ ...admin, connectTimeout: 3000 });
    await conn.end();
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const unreachable = await reachable();
export const dbAvailable = unreachable === undefined;
if (!dbAvailable) {
  console.warn(
    `\n⚠ MariaDB is not reachable at ${admin.host}:${admin.port} as ${admin.user} (${unreachable}).\n` +
      "  Integration tests are SKIPPED. Run scripts/ccr-session-init.sh or start `docker compose -f docker/compose.dev.yml up -d mariadb`.\n",
  );
}

export interface TestEnv {
  ctx: AppContext;
  handle: DbHandle;
  /** Move the test clock (Unix seconds). */
  clock: { now: number };
  signer: Signer;
  eventKeyFor: (eventId: number) => Promise<Uint8Array>;
  close(): Promise<void>;
}

export async function createTestEnv(overrides: Record<string, string> = {}): Promise<TestEnv> {
  const dbName = `${baseEnv.DB_NAME ?? "events_qr"}_test_${randomBytes(4).toString("hex")}`;
  const conn = await createConnection(admin);
  await conn.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4`);
  await conn.end();

  const config = loadConfig({
    DB_HOST: admin.host,
    DB_PORT: String(admin.port),
    DB_NAME: dbName,
    DB_USER: admin.user,
    DB_PASSWORD: admin.password,
    DB_POOL_SIZE: "20",
    NODE_ENV: "test",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    SYNC_HORIZON_SECONDS: "0",
    EMAIL_MIN_INTERVAL_MS: "0",
    ...overrides,
  });
  const handle = connectDb({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: dbName,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
    poolSize: config.DB_POOL_SIZE,
  });
  await runMigrations(handle.db);

  const pair = await generateSigningKeyPair();
  const signer = Signer.fromKeyPairs(1, [{ keyId: 1, ...pair }]);
  const masterKey = generateEventKey();
  const clock = { now: Math.floor(Date.now() / 1000) };
  const ctx: AppContext = { config, db: handle.db, signer, masterKey, now: () => clock.now };
  setContext(ctx);

  return {
    ctx,
    handle,
    clock,
    signer,
    eventKeyFor: async (eventId) => {
      const [row] = await handle.db
        .select()
        .from(mysqlSchema.events)
        .where(eq(mysqlSchema.events.id, eventId));
      return decryptEventKey(row!.encKeyRef, masterKey);
    },
    async close() {
      setContext(undefined);
      await handle.close();
      const drop = await createConnection(admin);
      await drop.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await drop.end();
    },
  };
}

const pinHashCache = new Map<string, Promise<string>>();
export const TEST_PIN = "correct-horse";
/** Supervisors and admins need 8+ digits. */
export const PRIVILEGED_PIN = "12345678";
export const pinFor = (role: string): string => (role === "staff" ? TEST_PIN : PRIVILEGED_PIN);

export interface TestStaff {
  id: string;
  name: string;
  role: StaffRole;
  cookie: string;
}

export async function makeStaff(env: TestEnv, role: StaffRole, name?: string): Promise<TestStaff> {
  const pin = pinFor(role);
  if (!pinHashCache.has(pin)) pinHashCache.set(pin, hashPin(pin));
  const id = randomUUID();
  const staffName = name ?? `${role}-${id.slice(0, 6)}`;
  await env.handle.db
    .insert(mysqlSchema.staff)
    .values({ id, name: staffName, pinHash: await pinHashCache.get(pin)!, role });
  return {
    id,
    name: staffName,
    role,
    cookie: `${SESSION_COOKIE}=${createSessionValue(env.ctx, id)}`,
  };
}

type Handler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  staff?: TestStaff | { cookie: string };
  bearer?: string;
  params?: Record<string, string>;
  query?: Record<string, string | number>;
  headers?: Record<string, string>;
}

/** Calls a route handler exactly as Next would: a Request in, a Response out. */
export async function call(handler: Handler, opts: CallOptions = {}) {
  const url = new URL("http://localhost:3000/api/test");
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...opts.headers };
  const hasBody = opts.body !== undefined || opts.rawBody !== undefined;
  if (hasBody) headers["content-type"] ??= "application/json";
  if (opts.staff) headers.cookie = opts.staff.cookie;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await handler(
    new Request(url, {
      method: opts.method ?? (hasBody ? "POST" : "GET"),
      headers,
      body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
    }),
    { params: Promise.resolve(opts.params ?? {}) },
  );
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke at response fields freely
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

/** A starter event: GA (capacity 20), VIP (limited to 3 entries), two gates. */
export function eventBody(startsAt: number, extra: Record<string, unknown> = {}) {
  return {
    name: "Summer Fest",
    venue: "Riverside Hall",
    timezone: "UTC",
    starts_at: startsAt,
    ends_at: startsAt + 6 * 3600,
    gates: ["Gate A", "Gate B", "VIP door"],
    ticket_types: [
      { idx: 0, name: "GA", capacity: 20 },
      { idx: 1, name: "VIP", entry_rule: { mode: "limited", max_admits: 3 }, gate_mask: 0b100 },
      { idx: 2, name: "Staff", entry_rule: { mode: "unlimited" } },
    ],
    ...extra,
  };
}

export const newKey = (): string => `key-${randomUUID()}`;
export { sha256Hex };
