import { createHmac } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { eq } from "drizzle-orm";
import { mysqlSchema, STAFF_ROLES } from "@events-qr/core";
import { cookieSecure, requireSetting } from "./config";
import type { AppContext } from "./context";
import { safeEqual, sha256Hex } from "./secrets";

const { staff: staffTable, devices } = mysqlSchema;

export type StaffRole = (typeof STAFF_ROLES)[number];
const RANK: Record<StaffRole, number> = { staff: 1, supervisor: 2, admin: 3 };

/** `have` meets `need` (admin > supervisor > staff). */
export const hasRole = (have: string, need: StaffRole): boolean =>
  (RANK[have as StaffRole] ?? 0) >= RANK[need];

export interface AuthedStaff {
  id: string;
  name: string;
  role: StaffRole;
}

export interface AuthedDevice {
  id: string;
  eventId: number;
  gate: string;
  direction: string;
  label: string | null;
}

export const SESSION_COOKIE = "eqr_session";
export const MIN_PIN_LENGTH = 6;

/** `Algorithm.Argon2id`; the enum is a const enum and cannot be imported under isolatedModules. */
const ARGON2ID = 2;
const ARGON = { algorithm: ARGON2ID } as const;

export const hashPin = (pin: string): Promise<string> => hash(pin, ARGON);

// Verified against when the name is unknown, so unknown and wrong-PIN logins take the same time.
let decoy: Promise<string> | undefined;
export async function verifyPin(pin: string, pinHash: string | undefined): Promise<boolean> {
  if (!pinHash) {
    decoy ??= hashPin("decoy-pin-not-a-real-credential");
    await verify(await decoy, pin).catch(() => false);
    return false;
  }
  return verify(pinHash, pin).catch(() => false);
}

function sign(ctx: AppContext, data: string): string {
  const secret = requireSetting(ctx.config, "SESSION_SECRET");
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function createSessionValue(ctx: AppContext, staffId: string): string {
  const exp = ctx.now() + Math.round(ctx.config.SESSION_TTL_HOURS * 3600);
  const data = Buffer.from(JSON.stringify({ sid: staffId, exp })).toString("base64url");
  return `${data}.${sign(ctx, data)}`;
}

export function sessionCookie(ctx: AppContext, value: string): string {
  const maxAge = Math.round(ctx.config.SESSION_TTL_HOURS * 3600);
  return cookieString(ctx, value, maxAge);
}

export function clearedSessionCookie(ctx: AppContext): string {
  return cookieString(ctx, "", 0);
}

function cookieString(ctx: AppContext, value: string, maxAge: number): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure(ctx.config)) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

/** The logged-in staff member for this request, or undefined. Role is read fresh from the database. */
export async function authenticateStaff(
  ctx: AppContext,
  req: Request,
): Promise<AuthedStaff | undefined> {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return undefined;
  const [data, mac] = cookie.split(".");
  if (!data || !mac || !safeEqual(mac, sign(ctx, data))) return undefined;
  let session: { sid?: unknown; exp?: unknown };
  try {
    session = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof session.sid !== "string" ||
    typeof session.exp !== "number" ||
    session.exp < ctx.now()
  ) {
    return undefined;
  }
  const [row] = await ctx.db
    .select()
    .from(staffTable)
    .where(eq(staffTable.id, session.sid))
    .limit(1);
  if (!row || !(row.role in RANK)) return undefined;
  return { id: row.id, name: row.name, role: row.role as StaffRole };
}

/** Device bearer tokens look like `<device id>.<secret>`; only the SHA-256 of the whole token is stored. */
export async function authenticateDevice(
  ctx: AppContext,
  req: Request,
): Promise<AuthedDevice | undefined> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return undefined;
  const token = header.slice(7).trim();
  const deviceId = token.split(".")[0];
  if (!deviceId || deviceId.length !== 36) return undefined;
  const [row] = await ctx.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
  if (!row || row.revoked || !safeEqual(row.tokenHash, sha256Hex(token))) return undefined;
  await ctx.db.update(devices).set({ lastSeenAt: ctx.now() }).where(eq(devices.id, row.id));
  return {
    id: row.id,
    eventId: row.eventId,
    gate: row.gate,
    direction: row.direction,
    label: row.label,
  };
}

/** Fixed-window failure counter per key. In memory: the app runs as a single instance. */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowSeconds: number,
  ) {}

  blocked(key: string, now: number): boolean {
    const entry = this.hits.get(key);
    return !!entry && entry.resetAt > now && entry.count >= this.max;
  }

  fail(key: string, now: number): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now)
      this.hits.set(key, { count: 1, resetAt: now + this.windowSeconds });
    else entry.count += 1;
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

export const loginLimiter = new FailureLimiter(5, 60);
export const loginIpLimiter = new FailureLimiter(30, 60);
