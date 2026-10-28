import { randomUUID } from "node:crypto";
import { eq, isNotNull, max, sql } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { unixNow } from "./context";
import { logAudit } from "./audit";
import { hashPin, pinProblem, type StaffRole } from "./auth";
import { badRequest, conflict, notFound } from "./http";

const { staff, auditLog, eventStaff, events, tickets } = mysqlSchema;

/** `now` is optional so scripts can pass just a database handle. */
type StaffCtx = Pick<AppContext, "db"> & { now?: () => number };
const nowOf = (ctx: StaffCtx): number => ctx.now?.() ?? unixNow();

export async function createStaff(
  ctx: StaffCtx,
  input: { name: string; pin: string; role: StaffRole },
  /** The admin creating the account; null for a server command. */
  actorId: string | null = null,
): Promise<{ id: string; name: string; role: StaffRole }> {
  const name = input.name.trim();
  if (!name) throw badRequest("name is required");
  const problem = pinProblem(input.role, input.pin);
  if (problem) throw badRequest(problem);
  if (await findStaffByName(ctx, name))
    throw conflict("name_taken", "a staff member with that name already exists");
  const id = randomUUID();
  const pinHash = await hashPin(input.pin);
  await ctx.db.transaction(async (tx) => {
    await tx.insert(staff).values({ id, name, pinHash, role: input.role });
    await logAudit(tx, {
      at: nowOf(ctx),
      actorStaffId: actorId,
      action: "staff.created",
      targetKind: "staff",
      targetId: id,
      detail: { name, role: input.role },
    });
  });
  return { id, name, role: input.role };
}

/** The staff member with this name, matched case-insensitively (as at login and in `createStaff`). Deactivated accounts count: their names stay taken. */
export async function findStaffByName(
  ctx: Pick<AppContext, "db">,
  name: string,
): Promise<{ id: string; name: string; role: string } | undefined> {
  const [row] = await ctx.db
    .select({ id: staff.id, name: staff.name, role: staff.role })
    .from(staff)
    .where(sql`LOWER(${staff.name}) = ${name.trim().toLowerCase()}`)
    .limit(1);
  return row;
}

/**
 * Gives an existing staff member a new PIN and role, clears any pending PIN reset and reactivates
 * the account, e.g. when `scripts/create-admin.ts --if-exists reset` is re-run for an admin whose
 * PIN is unknown. The row is kept: tickets, scans and event assignments still point at it. Logged
 * as `staff.recovered` with no actor.
 */
export async function resetStaff(
  ctx: StaffCtx,
  input: { name: string; pin: string; role: StaffRole },
): Promise<{ id: string; name: string; role: StaffRole }> {
  const problem = pinProblem(input.role, input.pin);
  if (problem) throw badRequest(problem);
  const row = await findStaffByName(ctx, input.name);
  if (!row) throw badRequest("no staff member with that name");
  const pinHash = await hashPin(input.pin);
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(staff).where(eq(staff.id, row.id)).for("update");
    await tx
      .update(staff)
      .set({ pinHash, role: input.role, pinReset: null, deactivatedAt: null })
      .where(eq(staff.id, row.id));
    await logAudit(tx, {
      at: nowOf(ctx),
      actorStaffId: null,
      action: "staff.recovered",
      targetKind: "staff",
      targetId: row.id,
      detail: {
        from_role: before?.role ?? null,
        to_role: input.role,
        was_deactivated: before?.deactivatedAt != null,
      },
    });
  });
  return { id: row.id, name: row.name, role: input.role };
}

export type StaffChange = { role: StaffRole } | { reset_pin: string } | { active: boolean };

/**
 * One admin change to one account, with the safety rules enforced inside the transaction that
 * makes it. Every staff row is locked (in id order, so two admins acting at once queue instead of
 * deadlocking): that is what stops two admins from demoting each other and leaving no admin.
 */
export async function updateStaff(
  ctx: StaffCtx,
  actorId: string,
  targetId: string,
  change: StaffChange,
): Promise<void> {
  const pinHash = "reset_pin" in change ? await hashPin(change.reset_pin) : undefined;
  await ctx.db.transaction(async (tx) => {
    const rows = await tx.select().from(staff).orderBy(staff.id).for("update");
    const target = rows.find((r) => r.id === targetId);
    if (!target) throw notFound("staff member not found");
    const activeAdmins = rows.filter((r) => r.role === "admin" && r.deactivatedAt === null);
    const isLastAdmin =
      target.role === "admin" && target.deactivatedAt === null && activeAdmins.length <= 1;
    const at = nowOf(ctx);
    const log = (
      action: Parameters<typeof logAudit>[1]["action"],
      detail?: Record<string, string>,
    ) => logAudit(tx, { at, actorStaffId: actorId, action, targetKind: "staff", targetId, detail });

    if ("role" in change) {
      if (change.role === target.role) throw badRequest(`already a ${target.role}`);
      if (targetId === actorId) throw conflict("self_change", "you cannot change your own role");
      if (isLastAdmin)
        throw conflict("last_admin", "this is the only active admin; add another admin first");
      await tx.update(staff).set({ role: change.role }).where(eq(staff.id, targetId));
      await log("staff.role_changed", { from: target.role, to: change.role });
    } else if ("reset_pin" in change) {
      if (target.deactivatedAt !== null)
        throw conflict("deactivated", "this account is deactivated; reactivate it first");
      const problem = pinProblem(target.role, change.reset_pin);
      if (problem) throw badRequest(problem);
      await tx.update(staff).set({ pinHash, pinReset: "admin" }).where(eq(staff.id, targetId));
      await log("staff.pin_reset");
    } else if (change.active) {
      if (target.deactivatedAt === null)
        throw conflict("already_active", "this account is already active");
      await tx.update(staff).set({ deactivatedAt: null }).where(eq(staff.id, targetId));
      await log("staff.reactivated");
    } else {
      if (target.deactivatedAt !== null)
        throw conflict("already_deactivated", "this account is already deactivated");
      if (targetId === actorId) throw conflict("self_change", "you cannot deactivate yourself");
      if (isLastAdmin)
        throw conflict("last_admin", "this is the only active admin; add another admin first");
      await tx.update(staff).set({ deactivatedAt: at }).where(eq(staff.id, targetId));
      await log("staff.deactivated");
    }
  });
}

/** Admin view of every account: status, events worked, and when it was created / last changed (from the log). */
export async function listStaff(ctx: Pick<AppContext, "db">) {
  const rows = await ctx.db.select().from(staff).orderBy(staff.name);
  const logged = await ctx.db
    .select({ id: auditLog.targetId, action: auditLog.action, at: max(auditLog.at) })
    .from(auditLog)
    .where(eq(auditLog.targetKind, "staff"))
    .groupBy(auditLog.targetId, auditLog.action);
  const created = new Map<string, number>();
  const changed = new Map<string, number>();
  for (const l of logged) {
    if (l.at === null) continue;
    if (l.action === "staff.created") created.set(l.id, l.at);
    changed.set(l.id, Math.max(changed.get(l.id) ?? 0, l.at));
  }

  // Same rule as `assignments()`: issuing tickets or an explicit add counts, an explicit removal wins.
  const issued = await ctx.db
    .selectDistinct({ staffId: tickets.issuedBy, eventId: tickets.eventId })
    .from(tickets)
    .where(isNotNull(tickets.issuedBy));
  const explicit = await ctx.db.select().from(eventStaff);
  const works = new Map<string, Map<number, boolean>>();
  const mark = (staffId: string, eventId: number, on: boolean) => {
    const m = works.get(staffId) ?? new Map<number, boolean>();
    m.set(eventId, on);
    works.set(staffId, m);
  };
  for (const r of issued) if (r.staffId) mark(r.staffId, r.eventId, true);
  for (const r of explicit) mark(r.staffId, r.eventId, r.assigned);
  const eventNames = new Map(
    (await ctx.db.select({ id: events.id, name: events.name }).from(events)).map((e) => [
      e.id,
      e.name,
    ]),
  );

  const list = rows.map((s) => ({
    id: s.id,
    name: s.name,
    role: s.role as StaffRole,
    status: (s.deactivatedAt !== null
      ? "deactivated"
      : s.pinReset
        ? "must_change_pin"
        : "active") as "active" | "must_change_pin" | "deactivated",
    events: [...(works.get(s.id) ?? [])]
      .filter(([, on]) => on)
      .map(([id]) => ({ id, name: eventNames.get(id) ?? `Event ${id}` }))
      .sort((a, b) => a.id - b.id),
    created_at: created.get(s.id) ?? null,
    changed_at: changed.get(s.id) ?? null,
  }));
  return {
    staff: list,
    active_admins: rows.filter((s) => s.role === "admin" && s.deactivatedAt === null).length,
  };
}
