/**
 * The hub's atomic claim and exit on SQLite (docs/spec.md "The claim"). Same request and response
 * shapes as the VM's (src/server/claim.ts), same pure decisions (`decideClaim`/`decideExit`),
 * idempotent on the device-generated `scan_id`.
 *
 * The whole claim runs in `BEGIN IMMEDIATE`: SQLite serialises writers, and rows changed by the
 * conditional UPDATE (`status = 'valid' AND inside = 0`) says who won, so two gates claiming one
 * ticket at once cannot both be admitted. SQLite assigns every SET column from the row as it was
 * before the UPDATE, so the used-up test is the spec's `admits_used + 1 >= max_admits`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import {
  api,
  bytesToHex,
  decideClaim,
  decideExit,
  hexToBytes,
  sqliteSchema,
  type ClaimState,
  type EntryMode,
  type ScanResultValue,
  type TicketStatusValue,
} from "@events-qr/core";
import type { AuthedDevice } from "../server/auth";
import { badRequest, HttpError, notFound } from "../server/errors";
import { immediate, type HubContext } from "./context";
import { pullTicketsQuietly } from "./vmsync";

const { tickets, scans, staff, hubScanOutbox, devices } = sqliteSchema;
type TicketRow = typeof tickets.$inferSelect;
type ClaimBody = z.infer<typeof api.claimRequest>;
type ClaimResponse = z.infer<typeof api.claimResponse>;
type ExitResponse = z.infer<typeof api.exitResponse>;

const stateOf = (row: TicketRow): ClaimState => ({
  status: row.status as TicketStatusValue,
  admitsUsed: row.admitsUsed,
  inside: row.inside,
  entryMode: row.entryMode as EntryMode,
  maxAdmits: row.maxAdmits,
});

const RANK: Record<string, number> = { staff: 0, supervisor: 1, admin: 2 };

function checkRequest(
  ctx: HubContext,
  device: AuthedDevice,
  body: ClaimBody,
  need: "entry" | "exit",
): void {
  if (body.device_id !== device.id) throw new HttpError(403, "wrong_device", "device_id mismatch");
  if (device.direction !== "both" && device.direction !== need) {
    throw new HttpError(403, "wrong_direction", `this device is set up for ${device.direction}`);
  }
  if (body.staff_id) {
    const member = ctx.db
      .select({ role: staff.role, pinHash: staff.pinHash })
      .from(staff)
      .where(eq(staff.id, body.staff_id))
      .get();
    if (!member) throw badRequest("unknown staff_id");
    // A sync replaces the hash of anyone the VM no longer lists (deactivated or unassigned) with
    // "", so an empty hash is how the hub learns an account was deactivated.
    if (!member.pinHash)
      throw new HttpError(403, "staff_deactivated", "this account was deactivated");
    if (body.override && (RANK[member.role] ?? 0) < RANK.supervisor!) {
      throw new HttpError(403, "forbidden", "an override needs a supervisor");
    }
    if (body.override && !member.pinHash)
      throw new HttpError(403, "pin_change_required", "this supervisor is not active at this hub");
  } else if (body.override) {
    throw badRequest("an override needs the supervisor's staff_id");
  }
}

function findTicket(ctx: HubContext, device: AuthedDevice, ticketIdHex: string) {
  return ctx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.id, hexToBytes(ticketIdHex)), eq(tickets.eventId, device.eventId)))
    .get();
}

/**
 * A ticket issued after the hub's last pull: ask the VM for it now (the "on demand" pull), then
 * look again. With the VM unreachable the ticket stays unknown and the phone shows an error.
 */
async function requireTicket(ctx: HubContext, device: AuthedDevice, ticketIdHex: string) {
  let row = findTicket(ctx, device, ticketIdHex);
  if (!row) {
    await pullTicketsQuietly(ctx);
    row = findTicket(ctx, device, ticketIdHex);
  }
  if (!row) throw notFound("ticket not found for this event");
}

/** The ticket's most recent admission, for the red "already used / still inside" screen. */
function lastAdmission(ctx: HubContext, ticketId: Uint8Array) {
  const row = ctx.db
    .select({ gate: scans.gate, at: scans.scannedAt, device: scans.deviceId })
    .from(scans)
    .where(
      and(
        eq(scans.ticketId, ticketId),
        eq(scans.direction, "entry"),
        inArray(scans.result, ["admitted", "override"]),
      ),
    )
    .orderBy(desc(scans.scannedAt), desc(scans.receivedAt))
    .limit(1)
    .get();
  if (!row) return row;
  const dev = row.device
    ? ctx.db.select({ label: devices.label }).from(devices).where(eq(devices.id, row.device)).get()
    : undefined;
  return { ...row, ...(dev?.label ? { device_label: dev.label } : {}) };
}

function insertScan(
  ctx: HubContext,
  device: AuthedDevice,
  body: ClaimBody,
  direction: "entry" | "exit",
  result: ScanResultValue,
): void {
  ctx.db
    .insert(scans)
    .values({
      id: body.scan_id,
      ticketId: hexToBytes(body.ticket_id),
      deviceId: device.id,
      staffId: body.staff_id ?? null,
      gate: device.gate,
      direction,
      scannedAt: body.scanned_at,
      receivedAt: ctx.now(),
      result,
      offline: false,
    })
    .run();
  ctx.db.insert(hubScanOutbox).values({ scanId: body.scan_id }).onConflictDoNothing().run();
}

type StoredScan = typeof scans.$inferSelect;

/** A retry of a stored scan: same verdict, current counts. A reused id for another scan is refused. */
function storedScan(
  ctx: HubContext,
  device: AuthedDevice,
  body: ClaimBody,
): StoredScan | undefined {
  const scan = ctx.db.select().from(scans).where(eq(scans.id, body.scan_id)).get();
  if (!scan) return undefined;
  if (scan.deviceId !== device.id || bytesToHex(scan.ticketId) !== body.ticket_id)
    throw new HttpError(409, "scan_id_reused", "scan_id belongs to a different scan");
  return scan;
}

function replayClaim(ctx: HubContext, device: AuthedDevice, scan: StoredScan): ClaimResponse {
  const row = findTicket(ctx, device, bytesToHex(scan.ticketId));
  if (!row) throw notFound("ticket not found for this event");
  const base = { admits_used: row.admitsUsed, limit: row.maxAdmits };
  if (scan.result === "admitted" || scan.result === "override")
    return { result: "admitted", ...base };
  if (row.status === "cancelled" && scan.result === "rejected_invalid")
    return { result: "rejected_cancelled" };
  const first = lastAdmission(ctx, row.id);
  return {
    result: scan.result === "rejected_inside" ? "rejected_inside" : "rejected_used",
    ...base,
    ...(first ? { first_scan: first } : {}),
  };
}

export async function claimTicket(
  ctx: HubContext,
  device: AuthedDevice,
  body: ClaimBody,
): Promise<ClaimResponse> {
  checkRequest(ctx, device, body, "entry");
  await requireTicket(ctx, device, body.ticket_id);
  const id = hexToBytes(body.ticket_id);

  return immediate(ctx, (): ClaimResponse => {
    const seen = storedScan(ctx, device, body);
    if (seen) return replayClaim(ctx, device, seen);

    const res = ctx.db.run(sql`
      UPDATE tickets
         SET admits_used = admits_used + 1,
             inside = 1,
             status = CASE WHEN max_admits IS NOT NULL AND admits_used + 1 >= max_admits
                           THEN 'used_up' ELSE status END,
             updated_at = max(${ctx.now()}, updated_at)
       WHERE id = ${Buffer.from(id)} AND event_id = ${device.eventId}
         AND status = 'valid' AND inside = 0`);
    const row = findTicket(ctx, device, body.ticket_id);
    if (!row) throw notFound("ticket not found for this event");
    if (res.changes === 1) {
      insertScan(ctx, device, body, "entry", body.override ? "override" : "admitted");
      return { result: "admitted", admits_used: row.admitsUsed, limit: row.maxAdmits };
    }

    const decision = decideClaim(stateOf(row));
    if (decision.result === "rejected_cancelled") {
      insertScan(ctx, device, body, "entry", "rejected_invalid");
      return { result: "rejected_cancelled" };
    }
    if (decision.result === "admitted") {
      // The conditional UPDATE refused but the pure rule would admit: the two have drifted.
      throw new Error("claim: SQL and decideClaim disagree");
    }
    insertScan(ctx, device, body, "entry", decision.result);
    const first = lastAdmission(ctx, row.id);
    return {
      result: decision.result,
      admits_used: row.admitsUsed,
      limit: row.maxAdmits,
      ...(first ? { first_scan: first } : {}),
    };
  });
}

export async function exitTicket(
  ctx: HubContext,
  device: AuthedDevice,
  body: z.infer<typeof api.exitRequest>,
): Promise<ExitResponse> {
  checkRequest(ctx, device, { ...body, override: false }, "exit");
  await requireTicket(ctx, device, body.ticket_id);

  return immediate(ctx, (): ExitResponse => {
    const seen = storedScan(ctx, device, body);
    if (seen) {
      const row = findTicket(ctx, device, body.ticket_id);
      if (!row) throw notFound("ticket not found for this event");
      if (seen.result === "rejected_invalid") return { result: "rejected_cancelled" };
      if (row.entryMode === "single") return { result: "no_reentry" };
      return {
        result: "exited",
        entries_left: row.maxAdmits === null ? null : Math.max(0, row.maxAdmits - row.admitsUsed),
      };
    }

    const row = findTicket(ctx, device, body.ticket_id);
    if (!row) throw notFound("ticket not found for this event");
    const decision = decideExit(stateOf(row));
    if (decision.result === "rejected_cancelled") {
      insertScan(ctx, device, body, "exit", "rejected_invalid");
      return { result: "rejected_cancelled" };
    }
    // Single-entry tickets log the exit with no state change (grey screen).
    insertScan(ctx, device, body, "exit", "exited");
    if (decision.result !== "exited") return { result: "no_reentry" };
    if (decision.changed) {
      ctx.db.run(sql`
        UPDATE tickets SET inside = 0, updated_at = max(${ctx.now()}, updated_at)
         WHERE id = ${Buffer.from(row.id)} AND inside = 1 AND entry_mode <> 'single'`);
    }
    return { result: "exited", entries_left: decision.entriesLeft };
  });
}
