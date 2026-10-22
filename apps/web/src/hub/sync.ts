/** `GET /api/sync` on the hub: the device pull. Same page shape the VM serves (src/server/sync.ts). */
import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { z } from "zod";
import { api, bytesToHex, hexToBytes, sqliteSchema } from "@events-qr/core";
import type { AuthedDevice } from "../server/auth";
import { offlineGateOnly } from "../server/settings";
import type { HubContext } from "./context";

const { tickets, ticketTypes, staff, events } = sqliteSchema;
type TicketRow = typeof tickets.$inferSelect;

export function toSyncTicket(row: TicketRow): z.infer<typeof api.syncTicket> {
  return {
    id: bytesToHex(row.id),
    event_id: row.eventId,
    ticket_type: row.ticketType,
    holder_name: row.holderName,
    entry_mode: row.entryMode as "single" | "unlimited" | "limited",
    max_admits: row.maxAdmits,
    gate_mask: row.gateMask,
    slot_start: row.slotStart,
    slot_end: row.slotEnd,
    admits_used: row.admitsUsed,
    inside: row.inside,
    status: row.status as "valid" | "used_up" | "cancelled",
    updated_at: row.updatedAt,
    cancelled_at: row.cancelledAt,
  };
}

/**
 * Tickets changed after the phone's `(updated_at, id)` cursor, including `admits_used` and
 * `inside` (what other gates admitted). Rows younger than SYNC_HORIZON_SECONDS are held back so a
 * claim that commits in the same second as a page can never land behind the cursor.
 */
export function syncForDevice(
  ctx: HubContext,
  device: AuthedDevice,
  query: z.infer<typeof api.hubSyncQuery>,
): z.infer<typeof api.hubSyncResponse> {
  const limit = 1000;
  const horizon = ctx.now() - ctx.config.SYNC_HORIZON_SECONDS;
  const conditions = [eq(tickets.eventId, device.eventId), sql`${tickets.updatedAt} <= ${horizon}`];
  if (query.cursor) {
    const [updatedAt, idHex] = query.cursor.split(":") as [string, string];
    conditions.push(
      sql`(${tickets.updatedAt} > ${Number(updatedAt)} OR (${tickets.updatedAt} = ${Number(updatedAt)} AND ${tickets.id} > ${Buffer.from(hexToBytes(idHex))}))`,
    );
  }
  const rows = ctx.db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.updatedAt), asc(tickets.id))
    .limit(limit + 1)
    .all();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const types = ctx.db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, device.eventId))
    .orderBy(asc(ticketTypes.idx))
    .all();
  const event = ctx.db.select().from(events).where(eq(events.id, device.eventId)).get();
  return {
    tickets: page.map(toSyncTicket),
    staff: ctx.db
      .select()
      .from(staff)
      .where(ne(staff.pinHash, ""))
      .all()
      .map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role as "staff" | "supervisor" | "admin",
        pin_hash: s.pinHash,
      })),
    settings: { offline_gate_only: offlineGateOnly(event?.config) },
    // A revoked device is refused at authentication (401) and wipes itself, so only itself here.
    devices: [
      {
        id: device.id,
        gate: device.gate,
        direction: device.direction as "entry" | "exit" | "both",
        revoked: false,
      },
    ],
    ticket_types: types.map((t) => ({
      idx: t.idx,
      name: t.name,
      early_entry_min: t.earlyEntryMin,
    })),
    next_cursor: last ? `${last.updatedAt}:${bytesToHex(last.id)}` : null,
    has_more: rows.length > limit,
    hub_time: ctx.now(),
  };
}
