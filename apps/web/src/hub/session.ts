import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { sqliteSchema } from "@events-qr/core";
import {
  decodeSession,
  encodeSession,
  readCookie,
  SESSION_COOKIE,
  type AuthedStaff,
} from "../server/auth";
import type { HubContext } from "./context";
import { getState, setState } from "./state";

const { staff } = sqliteSchema;

/** The hub has no SESSION_SECRET (it holds none of the VM's secrets): it makes its own once, kept in its SQLite file. */
function hubSecret(ctx: HubContext): string {
  let secret = getState(ctx, "session_secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    setState(ctx, "session_secret", secret);
  }
  return secret;
}

export function createHubSession(ctx: HubContext, staffId: string): string {
  const exp = ctx.now() + Math.round(ctx.config.SESSION_TTL_HOURS * 3600);
  return encodeSession(hubSecret(ctx), staffId, exp);
}

const RANK_ROLES = new Set(["staff", "supervisor", "admin"]);

/** The staff member behind this request's hub session. Someone whose hash left the hub (empty) no longer counts. */
export function authenticateHubStaff(ctx: HubContext, req: Request): AuthedStaff | undefined {
  const cookie = readCookie(req, SESSION_COOKIE);
  if (!cookie) return undefined;
  const sid = decodeSession(hubSecret(ctx), cookie, ctx.now());
  if (!sid) return undefined;
  const row = ctx.db.select().from(staff).where(eq(staff.id, sid)).get();
  if (!row || !row.pinHash || !RANK_ROLES.has(row.role)) return undefined;
  return { id: row.id, name: row.name, role: row.role as AuthedStaff["role"], pinReset: null };
}
