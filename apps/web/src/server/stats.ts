import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { api, bytesToHex, mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { loadEvent } from "./events";

const { scans, tickets } = mysqlSchema;

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
  const where = and(
    eq(tickets.eventId, eventId),
    eq(scans.conflict, true),
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
    .where(and(eq(tickets.eventId, eventId), eq(scans.conflict, true)));

  const canonical = new Map<string, { gate: string; scanned_at: number }>();
  const ids = [...new Set(rows.map((r) => r.scan.ticketId))];
  if (ids.length) {
    const firsts = await ctx.db
      .select({ ticketId: scans.ticketId, gate: scans.gate, scannedAt: scans.scannedAt })
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
      if (!canonical.has(key)) canonical.set(key, { gate: f.gate, scanned_at: f.scannedAt });
    }
  }
  return {
    conflicts: rows.map(({ scan: s, holder, status }) => ({
      scan_id: s.id,
      ticket_id: bytesToHex(s.ticketId),
      holder_name: holder,
      gate: s.gate,
      device_id: s.deviceId,
      scanned_at: s.scannedAt,
      received_at: s.receivedAt,
      offline: s.offline,
      canonical: canonical.get(bytesToHex(s.ticketId)) ?? null,
      ticket_status: status as "valid" | "used_up" | "cancelled",
    })),
    total: Number(total),
  };
}
