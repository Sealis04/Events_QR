import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { api, bytesToHex, hexToBytes, mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { toBuffer } from "./dbutil";
import type { AuthedDevice } from "./auth";
import { loadEvent, loadTypes, scannerTypes } from "./events";
import { badRequest } from "./http";

const { tickets, scans, devices, staff, enrolmentCodes } = mysqlSchema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TicketRow = typeof tickets.$inferSelect;

function toSyncTicket(row: TicketRow): z.infer<typeof api.syncTicket> {
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
  };
}

/**
 * Ticket changes for the device's event after the `(updated_at, id)` cursor. Rows younger than
 * SYNC_HORIZON_SECONDS are held back so a transaction that commits late can never land behind a
 * cursor that has already moved past it.
 */
export async function syncTickets(
  ctx: AppContext,
  device: AuthedDevice,
  query: z.infer<typeof api.syncTicketsQuery>,
): Promise<z.infer<typeof api.syncTicketsResponse>> {
  const horizon = ctx.now() - ctx.config.SYNC_HORIZON_SECONDS;
  const conditions = [eq(tickets.eventId, device.eventId), sql`${tickets.updatedAt} <= ${horizon}`];
  if (query.cursor) {
    const [updatedAt, idHexValue] = query.cursor.split(":") as [string, string];
    const id = toBuffer(hexToBytes(idHexValue));
    conditions.push(
      sql`(${tickets.updatedAt} > ${Number(updatedAt)} OR (${tickets.updatedAt} = ${Number(updatedAt)} AND ${tickets.id} > ${id}))`,
    );
  }
  const rows = await ctx.db
    .select()
    .from(tickets)
    .where(and(...conditions))
    .orderBy(asc(tickets.updatedAt), asc(tickets.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return {
    tickets: page.map(toSyncTicket),
    next_cursor: last ? `${last.updatedAt}:${bytesToHex(last.id)}` : null,
    has_more: rows.length > query.limit,
  };
}

export async function syncScans(
  ctx: AppContext,
  device: AuthedDevice,
  input: z.infer<typeof api.syncScansRequest>,
): Promise<z.infer<typeof api.syncScansResponse>> {
  const batch = [...new Map(input.scans.map((s) => [s.scan_id, s])).values()];
  const ticketIds = [...new Set(batch.map((s) => s.ticket_id))];
  const known = await ctx.db
    .select({ id: tickets.id })
    .from(tickets)
    .where(
      and(
        eq(tickets.eventId, device.eventId),
        inArray(
          tickets.id,
          ticketIds.map((h) => toBuffer(hexToBytes(h))),
        ),
      ),
    );
  const knownTickets = new Set(known.map((r) => bytesToHex(r.id)));

  // Scans may come from devices or staff this server has never heard of (enrolled at the hub).
  const deviceIds = [...new Set(batch.map((s) => s.device_id))];
  const staffIds = [...new Set(batch.flatMap((s) => (s.staff_id ? [s.staff_id] : [])))];
  const knownDevices = new Set(
    (
      await ctx.db.select({ id: devices.id }).from(devices).where(inArray(devices.id, deviceIds))
    ).map((r) => r.id),
  );
  const knownStaff = new Set(
    staffIds.length
      ? (await ctx.db.select({ id: staff.id }).from(staff).where(inArray(staff.id, staffIds))).map(
          (r) => r.id,
        )
      : [],
  );

  const accepted = batch.filter((s) => knownTickets.has(s.ticket_id));
  if (accepted.length === 0) return { acknowledged: [], conflicts: [] };

  const now = ctx.now();
  await ctx.db
    .insert(scans)
    .values(
      accepted.map((s) => ({
        id: s.scan_id,
        ticketId: toBuffer(hexToBytes(s.ticket_id)),
        deviceId: knownDevices.has(s.device_id) ? s.device_id : null,
        staffId: s.staff_id && knownStaff.has(s.staff_id) ? s.staff_id : null,
        gate: s.gate,
        direction: s.direction,
        scannedAt: s.scanned_at,
        receivedAt: now,
        result: s.result,
        offline: s.offline,
      })),
    )
    // Replays are no-ops: the device-generated id is the key.
    .onDuplicateKeyUpdate({ set: { id: sql`${scans.id}` } });

  for (const id of [...new Set(accepted.map((s) => s.ticket_id))].sort()) {
    await ctx.db.transaction((tx) => recomputeTicket(ctx, tx, id));
  }

  const flagged = await ctx.db
    .select({ id: scans.id })
    .from(scans)
    .where(
      and(
        inArray(
          scans.id,
          accepted.map((s) => s.scan_id),
        ),
        eq(scans.conflict, true),
      ),
    );
  return { acknowledged: accepted.map((s) => s.scan_id), conflicts: flagged.map((r) => r.id) };
}

/**
 * Rebuilds a ticket's derived state (`admits_used`, `inside`, `status`) and the `conflict` flags
 * from its scan rows, in `(scanned_at, id)` order (the hub uses the same order, so both converge). An entry while the holder is already inside, or past
 * the admit limit, is a conflict: the earlier scan stays canonical and the later row is flagged.
 * Order-independent, so late or replayed batches converge on the same answer.
 */
async function recomputeTicket(ctx: AppContext, tx: Tx, idHexValue: string): Promise<void> {
  const id = toBuffer(hexToBytes(idHexValue));
  const [ticket] = await tx.select().from(tickets).where(eq(tickets.id, id)).for("update");
  if (!ticket) return;
  const rows = await tx
    .select({
      id: scans.id,
      direction: scans.direction,
      result: scans.result,
      conflict: scans.conflict,
    })
    .from(scans)
    .where(and(eq(scans.ticketId, id), inArray(scans.result, ["admitted", "override", "exited"])))
    .orderBy(asc(scans.scannedAt), asc(scans.id));

  let admits = 0;
  let inside = false;
  const conflicted = new Set<string>();
  for (const row of rows) {
    if (row.result === "exited") {
      inside = false;
    } else if (row.direction === "entry") {
      const overLimit = ticket.maxAdmits !== null && admits >= ticket.maxAdmits;
      if (inside || overLimit) conflicted.add(row.id);
      admits += 1;
      inside = true;
    }
  }

  const toFlag = rows.filter((r) => conflicted.has(r.id) && !r.conflict).map((r) => r.id);
  const toClear = rows.filter((r) => !conflicted.has(r.id) && r.conflict).map((r) => r.id);
  if (toFlag.length)
    await tx.update(scans).set({ conflict: true }).where(inArray(scans.id, toFlag));
  if (toClear.length)
    await tx.update(scans).set({ conflict: false }).where(inArray(scans.id, toClear));

  const usedUp = ticket.maxAdmits !== null && admits >= ticket.maxAdmits;
  const status = ticket.status === "cancelled" ? "cancelled" : usedUp ? "used_up" : "valid";
  if (admits !== ticket.admitsUsed || inside !== ticket.inside || status !== ticket.status) {
    await tx
      .update(tickets)
      .set({ admitsUsed: admits, inside, status, updatedAt: Math.max(ctx.now(), ticket.updatedAt) })
      .where(eq(tickets.id, id));
  }
}

/** `GET /api/sync`: the scanner-facing page. Same shape the hub serves in M4. */
export async function syncForDevice(
  ctx: AppContext,
  device: AuthedDevice,
  query: z.infer<typeof api.hubSyncQuery>,
): Promise<z.infer<typeof api.hubSyncResponse>> {
  const page = await syncTickets(ctx, device, { cursor: query.cursor, limit: 1000 });
  const types = await loadTypes(ctx.db, device.eventId);
  return {
    tickets: page.tickets,
    // A revoked device is refused at authentication (401) and wipes itself, so only itself here.
    devices: [
      {
        id: device.id,
        gate: device.gate,
        direction: device.direction as "entry" | "exit" | "both",
        revoked: false,
      },
    ],
    ticket_types: scannerTypes(types),
    next_cursor: page.next_cursor,
    has_more: page.has_more,
    hub_time: ctx.now(),
  };
}

/**
 * `GET /api/sync/meta` (hub): the small tables the hub mirrors: the event, ticket types, staff
 * with PIN hashes (phone login at the hub), the event's scanner devices and unused phone codes.
 */
export async function syncMeta(
  ctx: AppContext,
  device: AuthedDevice,
): Promise<z.infer<typeof api.syncMetaResponse>> {
  const now = ctx.now();
  const event = await loadEvent(ctx.db, device.eventId);
  const types = await loadTypes(ctx.db, event.id);
  const staffRows = await ctx.db.select().from(staff);
  const deviceRows = await ctx.db
    .select()
    .from(devices)
    .where(and(eq(devices.eventId, event.id), eq(devices.kind, "scanner")));
  const codeRows = await ctx.db
    .select()
    .from(enrolmentCodes)
    .where(
      and(
        eq(enrolmentCodes.eventId, event.id),
        eq(enrolmentCodes.kind, "scanner"),
        sql`${enrolmentCodes.usedAt} IS NULL`,
        gt(enrolmentCodes.expiresAt, now),
      ),
    );
  return {
    event: {
      id: event.id,
      name: event.name,
      starts_at: event.startsAt,
      ends_at: event.endsAt,
      sign_key_id: event.signKeyId,
      gates: event.gates,
      config: (event.config ?? null) as Record<string, unknown> | null,
    },
    ticket_types: types.map((t) => ({
      idx: t.idx,
      name: t.name,
      capacity: t.capacity,
      issued: t.issued,
      entry_mode: t.entryMode as "single" | "unlimited" | "limited",
      max_admits: t.maxAdmits,
      gate_mask: t.gateMask,
      slots: t.slots ?? null,
      early_entry_min: t.earlyEntryMin,
    })),
    staff: staffRows.map((s) => ({
      id: s.id,
      name: s.name,
      pin_hash: s.pinHash,
      role: s.role as "staff" | "supervisor" | "admin",
    })),
    devices: deviceRows.map((d) => ({
      id: d.id,
      gate: d.gate,
      direction: d.direction as "entry" | "exit" | "both",
      label: d.label,
      token_hash: d.tokenHash,
      revoked: d.revoked,
    })),
    enrolment_codes: codeRows.map((c) => ({
      code_hash: c.codeHash,
      gate: c.gate,
      direction: c.direction as "entry" | "exit" | "both",
      label: c.label,
      expires_at: c.expiresAt,
    })),
    server_time: now,
  };
}

/**
 * `GET /api/sync/scans` (hub): the scans this server holds, after a `(received_at, id)` cursor,
 * so the hub also learns about admits that happened at the VM while the hub was unreachable.
 * Like the ticket feed it holds back rows younger than the sync horizon.
 */
export async function syncVmScans(
  ctx: AppContext,
  device: AuthedDevice,
  query: z.infer<typeof api.syncVmScansQuery>,
): Promise<z.infer<typeof api.syncVmScansResponse>> {
  const horizon = ctx.now() - ctx.config.SYNC_HORIZON_SECONDS;
  const conditions = [
    eq(tickets.eventId, device.eventId),
    sql`${scans.receivedAt} IS NOT NULL`,
    sql`${scans.receivedAt} <= ${horizon}`,
  ];
  if (query.cursor) {
    const [receivedAt, id] = query.cursor.split(":") as [string, string];
    conditions.push(
      or(
        gt(scans.receivedAt, Number(receivedAt)),
        and(eq(scans.receivedAt, Number(receivedAt)), gt(scans.id, id)),
      )!,
    );
  }
  const rows = await ctx.db
    .select({ scan: scans })
    .from(scans)
    .innerJoin(tickets, eq(tickets.id, scans.ticketId))
    .where(and(...conditions))
    .orderBy(asc(scans.receivedAt), asc(scans.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit).map((r) => r.scan);
  const last = page[page.length - 1];
  return {
    scans: page.map((s) => ({
      scan_id: s.id,
      ticket_id: bytesToHex(s.ticketId),
      // Devices or staff the hub has never heard of come through as the nil id the hub maps to null.
      device_id: s.deviceId ?? NIL_UUID,
      staff_id: s.staffId,
      gate: s.gate,
      direction: s.direction as "entry" | "exit",
      scanned_at: s.scannedAt,
      result: s.result as z.infer<typeof api.scanResult>,
      offline: s.offline,
      received_at: s.receivedAt,
    })),
    next_cursor: last ? `${last.receivedAt}:${last.id}` : null,
    has_more: rows.length > query.limit,
  };
}

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * `POST /api/sync/devices` (hub): phones enrolled at the hub become valid devices here, so their
 * token also works against the VM when the hub is unreachable. Idempotent on the device id; the
 * one-time code they used is marked used, and a device the VM already knows is left alone.
 */
export async function syncDevices(
  ctx: AppContext,
  device: AuthedDevice,
  input: z.infer<typeof api.syncDevicesRequest>,
): Promise<z.infer<typeof api.syncDevicesResponse>> {
  const event = await loadEvent(ctx.db, device.eventId);
  const acknowledged: string[] = [];
  for (const d of input.devices) {
    if (!event.gates.includes(d.gate)) throw badRequest(`"${d.gate}" is not a gate of this event`);
    await ctx.db.transaction(async (tx) => {
      const [known] = await tx
        .select({ id: devices.id, eventId: devices.eventId })
        .from(devices)
        .where(eq(devices.id, d.id))
        .limit(1);
      if (known && known.eventId !== event.id) throw badRequest("device belongs to another event");
      if (!known) {
        await tx.insert(devices).values({
          id: d.id,
          eventId: event.id,
          label: d.label,
          gate: d.gate,
          direction: d.direction,
          tokenHash: d.token_hash,
          lastSeenAt: d.enrolled_at,
          kind: "scanner",
        });
      }
      await tx
        .update(enrolmentCodes)
        .set({ usedAt: d.enrolled_at, deviceId: d.id })
        .where(
          and(
            eq(enrolmentCodes.codeHash, d.code_hash),
            eq(enrolmentCodes.eventId, event.id),
            sql`${enrolmentCodes.usedAt} IS NULL`,
          ),
        );
    });
    acknowledged.push(d.id);
  }
  return { acknowledged };
}
