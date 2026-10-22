/**
 * The scanner-facing hub API on the VM: atomic entry claim and exit (docs/spec.md "The claim"),
 * idempotent on the device-generated `scan_id`. M4 serves the same shapes from SQLite on the hub.
 *
 * Every attempt is logged as a scan row. The ticket row is only changed by the conditional UPDATE
 * (`status = 'valid' AND inside = 0`), and rows affected decides who wins, so two gates claiming
 * one ticket at once cannot both be admitted. A rejected attempt because the ticket is cancelled
 * has no scan result of its own and is logged as `rejected_invalid`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  api,
  decideClaim,
  decideExit,
  hexToBytes,
  mysqlSchema,
  type ClaimState,
  type EntryMode,
  type ScanResultValue,
  type TicketStatusValue,
} from "@events-qr/core";
import type { AuthedDevice } from "./auth";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { affectedRows, isDuplicate, toBuffer } from "./dbutil";
import { badRequest, HttpError, notFound } from "./http";

const { tickets, scans, staff } = mysqlSchema;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
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

/** Thrown inside a transaction when another request already stored this `scan_id`. */
class ScanReplay extends Error {}

const RANK: Record<string, number> = { staff: 0, supervisor: 1, admin: 2 };

/** `dashboard`: a supervisor's manual admit from the dashboard, which has no device row. */
export interface ClaimOptions {
  dashboard?: boolean;
}

async function checkRequest(
  ctx: AppContext,
  device: AuthedDevice,
  body: ClaimBody,
  need: "entry" | "exit",
  options: ClaimOptions = {},
): Promise<void> {
  if (!options.dashboard) {
    if (body.device_id !== device.id)
      throw new HttpError(403, "wrong_device", "device_id mismatch");
    if (device.kind !== "scanner") throw new HttpError(403, "forbidden", "a hub cannot scan");
    if (device.direction !== "both" && device.direction !== need) {
      throw new HttpError(403, "wrong_direction", `this device is set up for ${device.direction}`);
    }
  }
  if (body.staff_id) {
    const [member] = await ctx.db
      .select({ role: staff.role, pinReset: staff.pinReset })
      .from(staff)
      .where(eq(staff.id, body.staff_id))
      .limit(1);
    if (!member) throw badRequest("unknown staff_id");
    if (body.override && (RANK[member.role] ?? 0) < RANK.supervisor!) {
      throw new HttpError(403, "forbidden", "an override needs a supervisor");
    }
    if (body.override && member.pinReset)
      throw new HttpError(
        403,
        "pin_change_required",
        "this supervisor must choose a new PIN first",
      );
  } else if (body.override) {
    throw badRequest("an override needs the supervisor's staff_id");
  }
}

async function lockTicket(tx: Tx, device: AuthedDevice, ticketIdHex: string): Promise<TicketRow> {
  const [row] = await tx
    .select()
    .from(tickets)
    .where(
      and(eq(tickets.id, toBuffer(hexToBytes(ticketIdHex))), eq(tickets.eventId, device.eventId)),
    )
    .for("update");
  if (!row) throw notFound("ticket not found for this event");
  return row;
}

/** The ticket's most recent admission, for the red "already used / still inside" screen. */
async function lastAdmission(tx: Tx, ticketId: Uint8Array) {
  const [row] = await tx
    .select({ gate: scans.gate, at: scans.scannedAt, device: scans.deviceId })
    .from(scans)
    .where(
      and(
        eq(scans.ticketId, toBuffer(ticketId)),
        eq(scans.direction, "entry"),
        inArray(scans.result, ["admitted", "override"]),
      ),
    )
    .orderBy(desc(scans.scannedAt), desc(scans.receivedAt))
    .limit(1);
  return row;
}

async function insertScan(
  ctx: AppContext,
  tx: Tx,
  device: AuthedDevice,
  body: ClaimBody,
  direction: "entry" | "exit",
  result: ScanResultValue,
  options: ClaimOptions = {},
): Promise<void> {
  try {
    await tx.insert(scans).values({
      id: body.scan_id,
      ticketId: toBuffer(hexToBytes(body.ticket_id)),
      deviceId: options.dashboard ? null : device.id,
      staffId: body.staff_id ?? null,
      gate: device.gate,
      direction,
      scannedAt: body.scanned_at,
      receivedAt: ctx.now(),
      result,
      offline: false,
    });
  } catch (err) {
    if (isDuplicate(err)) throw new ScanReplay();
    throw err;
  }
}

/** A retry of a stored scan gets the same verdict; counts are the ticket's current ones. */
async function replayClaim(ctx: AppContext, device: AuthedDevice, body: ClaimBody) {
  const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, body.scan_id)).limit(1);
  if (!scan || scan.deviceId !== device.id || bytesHex(scan.ticketId) !== body.ticket_id) {
    throw new HttpError(409, "scan_id_reused", "scan_id belongs to a different scan");
  }
  return ctx.db.transaction(async (tx) => {
    const row = await lockTicket(tx, device, body.ticket_id);
    const base = { admits_used: row.admitsUsed, limit: row.maxAdmits };
    if (scan.result === "admitted" || scan.result === "override")
      return { result: "admitted" as const, ...base };
    if (row.status === "cancelled" && scan.result === "rejected_invalid")
      return { result: "rejected_cancelled" as const };
    const first = await lastAdmission(tx, row.id);
    return {
      result: (scan.result === "rejected_inside" ? "rejected_inside" : "rejected_used") as
        "rejected_inside" | "rejected_used",
      ...base,
      ...(first ? { first_scan: first } : {}),
    };
  });
}

const bytesHex = (id: Uint8Array): string => Buffer.from(id).toString("hex");

export async function claimTicket(
  ctx: AppContext,
  device: AuthedDevice,
  body: ClaimBody,
  options: ClaimOptions = {},
): Promise<ClaimResponse> {
  await checkRequest(ctx, device, body, "entry", options);
  const id = toBuffer(hexToBytes(body.ticket_id));
  try {
    return await ctx.db.transaction(async (tx): Promise<ClaimResponse> => {
      const [seen] = await tx
        .select({ id: scans.id })
        .from(scans)
        .where(eq(scans.id, body.scan_id))
        .limit(1);
      if (seen) throw new ScanReplay();

      // MariaDB evaluates SET assignments left to right on the new values, and drizzle writes
      // them in schema column order (`admits_used` before `status`), so `status` sees the
      // already-incremented count. The limited-ticket test pins this.
      const [res] = await tx
        .update(tickets)
        .set({
          status: sql`CASE WHEN ${tickets.maxAdmits} IS NOT NULL AND ${tickets.admitsUsed} >= ${tickets.maxAdmits} THEN 'used_up' ELSE ${tickets.status} END`,
          admitsUsed: sql`${tickets.admitsUsed} + 1`,
          inside: true,
          updatedAt: sql`GREATEST(${ctx.now()}, ${tickets.updatedAt})`,
        })
        .where(
          and(
            eq(tickets.id, id),
            eq(tickets.eventId, device.eventId),
            eq(tickets.status, "valid"),
            eq(tickets.inside, false),
          ),
        );
      const row = await lockTicket(tx, device, body.ticket_id);
      if (affectedRows(res) === 1) {
        await insertScan(
          ctx,
          tx,
          device,
          body,
          "entry",
          body.override ? "override" : "admitted",
          options,
        );
        return { result: "admitted", admits_used: row.admitsUsed, limit: row.maxAdmits };
      }

      const decision = decideClaim(stateOf(row));
      if (decision.result === "rejected_cancelled") {
        await insertScan(ctx, tx, device, body, "entry", "rejected_invalid", options);
        return { result: "rejected_cancelled" };
      }
      if (decision.result === "admitted") {
        // The conditional UPDATE refused but the pure rule would admit: the two have drifted.
        throw new Error("claim: SQL and decideClaim disagree");
      }
      await insertScan(ctx, tx, device, body, "entry", decision.result, options);
      const first = await lastAdmission(tx, row.id);
      return {
        result: decision.result,
        admits_used: row.admitsUsed,
        limit: row.maxAdmits,
        ...(first ? { first_scan: first } : {}),
      };
    });
  } catch (err) {
    if (err instanceof ScanReplay) return replayClaim(ctx, device, body);
    throw err;
  }
}

export async function exitTicket(
  ctx: AppContext,
  device: AuthedDevice,
  body: z.infer<typeof api.exitRequest>,
): Promise<ExitResponse> {
  await checkRequest(ctx, device, { ...body, override: false }, "exit");
  try {
    return await ctx.db.transaction(async (tx): Promise<ExitResponse> => {
      const [seen] = await tx
        .select({ id: scans.id })
        .from(scans)
        .where(eq(scans.id, body.scan_id))
        .limit(1);
      if (seen) throw new ScanReplay();

      const row = await lockTicket(tx, device, body.ticket_id);
      const decision = decideExit(stateOf(row));
      if (decision.result === "rejected_cancelled") {
        await insertScan(ctx, tx, device, body, "exit", "rejected_invalid");
        return { result: "rejected_cancelled" };
      }
      // Single-entry tickets log the exit with no state change (grey screen).
      await insertScan(ctx, tx, device, body, "exit", "exited");
      if (decision.result !== "exited") return { result: "no_reentry" };
      if (decision.changed) {
        await tx
          .update(tickets)
          .set({ inside: false, updatedAt: sql`GREATEST(${ctx.now()}, ${tickets.updatedAt})` })
          .where(
            and(
              eq(tickets.id, row.id),
              eq(tickets.inside, true),
              sql`${tickets.entryMode} <> 'single'`,
            ),
          );
      }
      return { result: "exited", entries_left: decision.entriesLeft };
    });
  } catch (err) {
    if (err instanceof ScanReplay) {
      const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, body.scan_id)).limit(1);
      if (!scan || scan.deviceId !== device.id || bytesHex(scan.ticketId) !== body.ticket_id)
        throw new HttpError(409, "scan_id_reused", "scan_id belongs to a different scan");
      const [row] = await ctx.db
        .select()
        .from(tickets)
        .where(eq(tickets.id, toBuffer(hexToBytes(body.ticket_id))));
      if (!row) throw notFound("ticket not found for this event");
      if (scan.result === "rejected_invalid") return { result: "rejected_cancelled" };
      if (row.entryMode === "single") return { result: "no_reentry" };
      return {
        result: "exited",
        entries_left: row.maxAdmits === null ? null : Math.max(0, row.maxAdmits - row.admitsUsed),
      };
    }
    throw err;
  }
}
