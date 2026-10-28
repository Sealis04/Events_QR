import { and, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { api, bytesToHex, mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { loadEvent } from "./events";

const { scans, tickets, staff, devices, auditLog } = mysqlSchema;

/**
 * Scans made by an account that was deactivated at the scan's time (an offline phone keeps the
 * PIN hash until it syncs), as scan id -> start of the deactivation window that covers it. Such
 * scans are stored as usual; the Conflicts list shows them for review. Windows come from the
 * audit log (`staff.deactivated` opens one, `staff.reactivated` / `staff.recovered` closes it).
 * Pass an event id (all its scans) or scan ids.
 */
export async function deactivatedScans(
  ctx: Pick<AppContext, "db">,
  scope: number | string[],
): Promise<Map<string, number>> {
  const rows = await ctx.db
    .select({ id: scans.id, staffId: scans.staffId, at: scans.scannedAt })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(
      and(
        sql`${scans.staffId} IS NOT NULL`,
        typeof scope === "number" ? eq(tickets.eventId, scope) : inArray(scans.id, scope),
      ),
    );
  const out = new Map<string, number>();
  const staffIds = [...new Set(rows.map((r) => r.staffId!))];
  if (!staffIds.length) return out;
  const log = await ctx.db
    .select({ staffId: auditLog.targetId, action: auditLog.action, at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetKind, "staff"),
        inArray(auditLog.targetId, staffIds),
        inArray(auditLog.action, ["staff.deactivated", "staff.reactivated", "staff.recovered"]),
      ),
    )
    .orderBy(auditLog.at, auditLog.id);
  const windows = new Map<string, { from: number; to: number }[]>();
  for (const l of log) {
    const list = windows.get(l.staffId) ?? [];
    const open = list[list.length - 1];
    if (l.action === "staff.deactivated") {
      if (!open || open.to !== Infinity) list.push({ from: l.at, to: Infinity });
    } else if (open && open.to === Infinity) open.to = l.at;
    windows.set(l.staffId, list);
  }
  for (const r of rows) {
    const w = windows.get(r.staffId!)?.find((x) => r.at >= x.from && r.at < x.to);
    if (w) out.set(r.id, w.from);
  }
  return out;
}

const ADMIT_RESULTS = ["admitted", "override"];

/** Live counts for the dashboard. Entries only count `admitted` and supervisor `override` scans. */
export async function eventStats(
  ctx: AppContext,
  eventId: number,
): Promise<z.infer<typeof api.eventStatsResponse>> {
  await loadEvent(ctx.db, eventId);
  const entries = and(
    eq(tickets.eventId, eventId),
    eq(scans.direction, "entry"),
    inArray(scans.result, ADMIT_RESULTS),
  );

  const byGate = await ctx.db
    .select({ gate: scans.gate, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(scans.gate);

  const byType = await ctx.db
    .select({ type: tickets.ticketType, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(tickets.ticketType);

  const [{ inside = 0 } = {}] = await ctx.db
    .select({ inside: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(and(eq(tickets.eventId, eventId), eq(tickets.inside, true)));

  const [{ conflicts = 0 } = {}] = await ctx.db
    .select({ conflicts: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(eq(tickets.eventId, eventId), eq(scans.conflict, true)));

  const [{ open = 0 } = {}] = await ctx.db
    .select({ open: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(eq(tickets.eventId, eventId), eq(scans.conflict, true), isNull(scans.reviewedAt)));

  const [{ left = 0 } = {}] = await ctx.db
    .select({ left: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(
      and(
        eq(tickets.eventId, eventId),
        eq(tickets.inside, false),
        gt(tickets.admitsUsed, 0),
        sql`${tickets.status} <> 'cancelled'`,
      ),
    );

  const [{ lastMinute = 0 } = {}] = await ctx.db
    .select({ lastMinute: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(entries, gte(scans.scannedAt, ctx.now() - 60)));

  const [busiest] = await ctx.db
    .select({ minute: sql<number>`FLOOR(${scans.scannedAt} / 60) * 60`, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(sql`FLOOR(${scans.scannedAt} / 60)`)
    .orderBy(sql`COUNT(*) DESC`, sql`FLOOR(${scans.scannedAt} / 60)`)
    .limit(1);

  const since = ctx.now() - 3600;
  const perMinute = await ctx.db
    .select({ minute: sql<number>`FLOOR(${scans.scannedAt} / 60) * 60`, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(entries, gte(scans.scannedAt, since)))
    .groupBy(sql`FLOOR(${scans.scannedAt} / 60)`)
    .orderBy(sql`FLOOR(${scans.scannedAt} / 60)`);

  return {
    total_admitted: byGate.reduce((sum, r) => sum + Number(r.n), 0),
    inside: Number(inside),
    by_gate: Object.fromEntries(byGate.map((r) => [r.gate, Number(r.n)])),
    by_ticket_type: Object.fromEntries(byType.map((r) => [String(r.type), Number(r.n)])),
    conflicts: Number(conflicts),
    scans_per_minute: perMinute.map((r) => ({ minute: Number(r.minute), count: Number(r.n) })),
    left: Number(left),
    last_minute: Number(lastMinute),
    busiest: busiest ? { minute: Number(busiest.minute), count: Number(busiest.n) } : null,
    open_conflicts: Number(open),
  };
}

/**
 * The conflict feed: every scan flagged `conflict`, newest first, with the admit that stays
 * canonical for the same ticket. The dashboard (M6) and any alert read this.
 */
export async function listConflicts(
  ctx: AppContext,
  eventId: number,
  query: z.infer<typeof api.conflictsQuery>,
): Promise<z.infer<typeof api.conflictsResponse>> {
  await loadEvent(ctx.db, eventId);
  const flagged = await deactivatedScans(ctx, eventId);
  const isListed = flagged.size
    ? or(eq(scans.conflict, true), inArray(scans.id, [...flagged.keys()]))
    : eq(scans.conflict, true);
  const where = and(
    eq(tickets.eventId, eventId),
    isListed,
    query.before !== undefined ? sql`${scans.scannedAt} < ${query.before}` : undefined,
  );
  const rows = await ctx.db
    .select({ scan: scans, holder: tickets.holderName, status: tickets.status })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(where)
    .orderBy(sql`${scans.scannedAt} DESC`, scans.id)
    .limit(query.limit);
  const [{ total = 0 } = {}] = await ctx.db
    .select({ total: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(eq(tickets.eventId, eventId), isListed));

  const canonical = new Map<string, typeof scans.$inferSelect>();
  const ids = [...new Set(rows.map((r) => r.scan.ticketId))];
  if (ids.length) {
    const firsts = await ctx.db
      .select()
      .from(scans)
      .where(
        and(
          inArray(scans.ticketId, ids),
          eq(scans.direction, "entry"),
          inArray(scans.result, ADMIT_RESULTS),
          eq(scans.conflict, false),
        ),
      )
      .orderBy(scans.scannedAt, scans.id);
    for (const f of firsts) {
      const key = bytesToHex(f.ticketId);
      if (!canonical.has(key)) canonical.set(key, f);
    }
  }
  const staffIds = new Set<string>();
  const deviceIds = new Set<string>();
  for (const s of [...rows.map((r) => r.scan), ...canonical.values()]) {
    if (s.staffId) staffIds.add(s.staffId);
    if (s.deviceId) deviceIds.add(s.deviceId);
  }
  const staffNames = new Map(
    staffIds.size
      ? (
          await ctx.db
            .select({ id: staff.id, name: staff.name })
            .from(staff)
            .where(inArray(staff.id, [...staffIds]))
        ).map((s) => [s.id, s.name])
      : [],
  );
  const deviceLabels = new Map(
    deviceIds.size
      ? (
          await ctx.db
            .select({ id: devices.id, label: devices.label })
            .from(devices)
            .where(inArray(devices.id, [...deviceIds]))
        ).map((d) => [d.id, d.label])
      : [],
  );
  return {
    conflicts: rows.map(({ scan: s, holder, status }) => {
      const candidate = canonical.get(bytesToHex(s.ticketId));
      const first = candidate && candidate.id !== s.id ? candidate : undefined;
      const from = flagged.get(s.id);
      return {
        scan_id: s.id,
        ticket_id: bytesToHex(s.ticketId),
        holder_name: holder,
        gate: s.gate,
        device_id: s.deviceId,
        scanned_at: s.scannedAt,
        received_at: s.receivedAt,
        offline: s.offline,
        canonical: first ? { gate: first.gate, scanned_at: first.scannedAt } : null,
        ticket_status: status as "valid" | "used_up" | "cancelled",
        staff_id: s.staffId,
        staff_name: s.staffId ? (staffNames.get(s.staffId) ?? null) : null,
        device_label: s.deviceId ? (deviceLabels.get(s.deviceId) ?? null) : null,
        canonical_detail: first
          ? {
              gate: first.gate,
              scanned_at: first.scannedAt,
              offline: first.offline,
              device_id: first.deviceId,
              device_label: first.deviceId ? (deviceLabels.get(first.deviceId) ?? null) : null,
              staff_name: first.staffId ? (staffNames.get(first.staffId) ?? null) : null,
            }
          : null,
        reviewed_at: s.reviewedAt,
        result: s.result,
        deactivated_account: from === undefined ? null : { deactivated_at: from },
      };
    }),
    total: Number(total),
  };
}
