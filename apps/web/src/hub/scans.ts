/**
 * `POST /api/scans` on the hub: scans a phone decided without the hub (its outbox). Both rows are
 * kept; ticket state and `conflict` flags are rebuilt from the scans in `(scanned_at, id)` order,
 * so the earlier admit stays canonical and a later one is flagged. Idempotent on `scan_id`.
 */
import { inArray } from "drizzle-orm";
import type { z } from "zod";
import { api, bytesToHex, hexToBytes, sqliteSchema } from "@events-qr/core";
import type { AuthedDevice } from "../server/auth";
import { HttpError } from "../server/errors";
import { immediate, type HubContext } from "./context";
import { recomputeTicket } from "./recompute";

const { tickets, scans, staff, hubScanOutbox } = sqliteSchema;

export function uploadScans(
  ctx: HubContext,
  device: AuthedDevice,
  input: z.infer<typeof api.hubScansRequest>,
): z.infer<typeof api.hubScansResponse> {
  const batch = [...new Map(input.scans.map((s) => [s.scan_id, s])).values()];
  if (batch.some((s) => s.device_id !== device.id))
    throw new HttpError(403, "wrong_device", "device_id mismatch");

  return immediate(ctx, () => {
    const knownTickets = new Set(
      ctx.db
        .select({ id: tickets.id })
        .from(tickets)
        .where(inArray(tickets.id, [...new Set(batch.map((s) => s.ticket_id))].map(hexToBytes)))
        .all()
        .map((r) => bytesToHex(r.id)),
    );
    const knownStaff = new Set(
      ctx.db
        .select({ id: staff.id })
        .from(staff)
        .all()
        .map((s) => s.id),
    );
    const accepted = batch.filter((s) => knownTickets.has(s.ticket_id));
    const now = ctx.now();
    for (const s of accepted) {
      ctx.db
        .insert(scans)
        .values({
          id: s.scan_id,
          ticketId: hexToBytes(s.ticket_id),
          deviceId: device.id,
          staffId: s.staff_id && knownStaff.has(s.staff_id) ? s.staff_id : null,
          gate: s.gate,
          direction: s.direction,
          scannedAt: s.scanned_at,
          receivedAt: now,
          result: s.result,
          offline: s.offline,
        })
        .onConflictDoNothing()
        .run();
      ctx.db.insert(hubScanOutbox).values({ scanId: s.scan_id }).onConflictDoNothing().run();
    }
    for (const id of [...new Set(accepted.map((s) => s.ticket_id))].sort())
      recomputeTicket(ctx, id);

    const flagged = accepted.length
      ? ctx.db
          .select({ id: scans.id, conflict: scans.conflict })
          .from(scans)
          .where(
            inArray(
              scans.id,
              accepted.map((s) => s.scan_id),
            ),
          )
          .all()
          .filter((r) => r.conflict)
      : [];
    return { acknowledged: accepted.map((s) => s.scan_id), conflicts: flagged.map((r) => r.id) };
  });
}
