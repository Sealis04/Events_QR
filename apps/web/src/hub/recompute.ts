/**
 * Rebuilds a ticket's derived state (`admits_used`, `inside`, `status`) and the `conflict` flags
 * from its scan rows, in `(scanned_at, id)` order: the same rule, and the same order, as the VM's
 * recompute (src/server/sync.ts), so a hub and the VM that hold the same scans reach the same
 * answer. An entry while the holder is already inside, or past the admit limit, is a conflict: the
 * earlier scan stays canonical and the later row is flagged. Order-independent, so late or
 * replayed batches converge. Call inside `immediate()`.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { hexToBytes, replayScans, sqliteSchema } from "@events-qr/core";
import type { HubContext } from "./context";

const { tickets, scans } = sqliteSchema;

export function recomputeTicket(ctx: HubContext, ticketIdHex: string): void {
  const id = hexToBytes(ticketIdHex);
  const ticket = ctx.db.select().from(tickets).where(eq(tickets.id, id)).get();
  if (!ticket) return;
  const rows = ctx.db
    .select({
      id: scans.id,
      direction: scans.direction,
      result: scans.result,
      conflict: scans.conflict,
      offline: scans.offline,
      scannedAt: scans.scannedAt,
    })
    .from(scans)
    .where(and(eq(scans.ticketId, id), inArray(scans.result, ["admitted", "override", "exited"])))
    .orderBy(asc(scans.scannedAt), asc(scans.id))
    .all();

  const replay = replayScans(
    rows.map((r) => ({ ...r, direction: r.direction as "entry" | "exit" })),
    {
      maxAdmits: ticket.maxAdmits,
      status: ticket.status as "valid" | "used_up" | "cancelled",
      cancelledAt: ticket.cancelledAt,
    },
  );
  const { conflicts: conflicted } = replay;

  const toFlag = rows.filter((r) => conflicted.has(r.id) && !r.conflict).map((r) => r.id);
  const toClear = rows.filter((r) => !conflicted.has(r.id) && r.conflict).map((r) => r.id);
  if (toFlag.length)
    ctx.db.update(scans).set({ conflict: true }).where(inArray(scans.id, toFlag)).run();
  if (toClear.length)
    ctx.db.update(scans).set({ conflict: false }).where(inArray(scans.id, toClear)).run();

  const { admitsUsed: admits, inside, status } = replay;
  if (admits !== ticket.admitsUsed || inside !== ticket.inside || status !== ticket.status) {
    ctx.db
      .update(tickets)
      .set({
        admitsUsed: admits,
        inside,
        status,
        updatedAt: sql`max(${ctx.now()}, ${tickets.updatedAt})`,
      })
      .where(eq(tickets.id, id))
      .run();
  }
}
