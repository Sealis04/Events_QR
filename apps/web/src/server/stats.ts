import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { api, mysqlSchema } from "@events-qr/core";
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
