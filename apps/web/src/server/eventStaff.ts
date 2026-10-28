import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { loadEvent } from "./events";
import { conflict, notFound } from "./http";

const { staff, eventStaff, tickets } = mysqlSchema;

export type Assignment = "issued" | "added" | "removed" | null;

/** Who works this event and why: tickets issued, an explicit add, or an explicit removal (which wins). */
export async function assignments(
  ctx: AppContext,
  eventId: number,
): Promise<Map<string, Assignment>> {
  const out = new Map<string, Assignment>();
  const issuers = await ctx.db
    .selectDistinct({ id: tickets.issuedBy })
    .from(tickets)
    .where(and(eq(tickets.eventId, eventId), isNotNull(tickets.issuedBy)));
  for (const r of issuers) if (r.id) out.set(r.id, "issued");
  const explicit = await ctx.db.select().from(eventStaff).where(eq(eventStaff.eventId, eventId));
  for (const r of explicit) out.set(r.staffId, r.assigned ? "added" : "removed");
  return out;
}

/**
 * The staff whose PIN hashes phones and the hub may hold for this event (Sealis04/Events_QR#8):
 * assigned staff only, none once the event has ended, and nobody who must still change their PIN
 * (their old hash is exactly what must not be on a phone). Removal shows up as absence: the next
 * sync replaces the phone's list.
 */
export async function hashesForEvent(ctx: AppContext, eventId: number) {
  const event = await loadEvent(ctx.db, eventId);
  if (ctx.now() > event.endsAt) return [];
  const assigned = await assignments(ctx, eventId);
  const rows = await ctx.db.select().from(staff).where(isNull(staff.deactivatedAt));
  return rows
    .filter((s) => {
      const a = assigned.get(s.id);
      return (a === "issued" || a === "added") && !s.pinReset;
    })
    .map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role as "staff" | "supervisor" | "admin",
      pin_hash: s.pinHash,
    }));
}

/** Admin view: every active staff member with their assignment to this event. */
export async function listEventStaff(ctx: AppContext, eventId: number) {
  await loadEvent(ctx.db, eventId);
  const assigned = await assignments(ctx, eventId);
  const rows = await ctx.db
    .select()
    .from(staff)
    .where(isNull(staff.deactivatedAt))
    .orderBy(staff.name);
  return rows.map((s) => {
    const a = assigned.get(s.id) ?? null;
    return {
      id: s.id,
      name: s.name,
      role: s.role as "staff" | "supervisor" | "admin",
      assignment: a,
      assigned: a === "issued" || a === "added",
      pin_reset: (s.pinReset ?? null) as "weak" | "rotate" | "admin" | null,
    };
  });
}

/** `true` adds, `false` removes (even if they issued tickets), `null` goes back to the default. */
export async function setAssignment(
  ctx: AppContext,
  eventId: number,
  staffId: string,
  assigned: boolean | null,
): Promise<void> {
  await loadEvent(ctx.db, eventId);
  const [member] = await ctx.db
    .select({ id: staff.id, deactivatedAt: staff.deactivatedAt })
    .from(staff)
    .where(eq(staff.id, staffId));
  if (!member) throw notFound("staff member not found");
  if (assigned === true && member.deactivatedAt !== null)
    throw conflict(
      "deactivated",
      "this account is deactivated; reactivate it on the Staff page first",
    );
  if (assigned === null) {
    await ctx.db
      .delete(eventStaff)
      .where(and(eq(eventStaff.eventId, eventId), eq(eventStaff.staffId, staffId)));
    return;
  }
  await ctx.db
    .insert(eventStaff)
    .values({ eventId, staffId, assigned })
    .onDuplicateKeyUpdate({ set: { assigned } });
}
