import { desc, inArray, lt } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import type { Db } from "./db";

const { auditLog, staff } = mysqlSchema;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type AuditAction =
  | "staff.created"
  | "staff.role_changed"
  | "staff.pin_reset"
  | "staff.deactivated"
  | "staff.reactivated"
  | "staff.recovered";

export interface AuditInput {
  at: number;
  /** Null for a server command (`scripts/create-admin.ts`). */
  actorStaffId: string | null;
  action: AuditAction;
  targetKind: "staff";
  targetId: string;
  /** Never put a PIN or a hash in here. */
  detail?: Record<string, string | number | boolean | null>;
}

/** Writes one activity-log row. Call it inside the transaction that makes the change. */
export async function logAudit(tx: Pick<Tx, "insert">, entry: AuditInput): Promise<void> {
  await tx.insert(auditLog).values({
    at: entry.at,
    actorStaffId: entry.actorStaffId,
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    detail: entry.detail ?? null,
  });
}

export const AUDIT_PAGE_SIZE = 25;

/** The activity log, newest first. `before` is the `next_before` of the previous page. */
export async function listAuditLog(ctx: Pick<AppContext, "db">, before?: number) {
  const rows = await ctx.db
    .select()
    .from(auditLog)
    .where(before ? lt(auditLog.id, before) : undefined)
    .orderBy(desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1);
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const ids = new Set<string>();
  for (const r of page) {
    if (r.actorStaffId) ids.add(r.actorStaffId);
    if (r.targetKind === "staff") ids.add(r.targetId);
  }
  const names = new Map<string, string>();
  if (ids.size)
    for (const s of await ctx.db
      .select({ id: staff.id, name: staff.name })
      .from(staff)
      .where(inArray(staff.id, [...ids])))
      names.set(s.id, s.name);
  return {
    entries: page.map((r) => ({
      id: r.id,
      at: r.at,
      actor: r.actorStaffId
        ? { id: r.actorStaffId, name: names.get(r.actorStaffId) ?? "unknown" }
        : null,
      action: r.action,
      target: {
        kind: r.targetKind,
        id: r.targetId,
        name: r.targetKind === "staff" ? (names.get(r.targetId) ?? null) : null,
      },
      detail: r.detail ?? null,
    })),
    next_before: rows.length > AUDIT_PAGE_SIZE ? page[page.length - 1]!.id : null,
  };
}
