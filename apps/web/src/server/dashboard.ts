import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { api, bytesToHex, mysqlSchema } from "@events-qr/core";
import type { AuthedDevice, AuthedStaff } from "./auth";
import { verifyPin, loginLimiter } from "./auth";
import { claimTicket } from "./claim";
import type { AppContext } from "./context";
import { loadEvent } from "./events";
import { HttpError, notFound } from "./http";

const { scans, tickets, staff } = mysqlSchema;

/** `POST /api/events/{id}/admit`: manual admit from attendee search. The supervisor's PIN is asked again; the scan is an `override`. */
export async function manualAdmit(
  ctx: AppContext,
  who: AuthedStaff,
  eventId: number,
  input: z.infer<typeof api.manualAdmitRequest>,
): Promise<z.infer<typeof api.manualAdmitResponse>> {
  await loadEvent(ctx.db, eventId);
  const key = `admit|${who.id}`;
  const now = ctx.now();
  if (loginLimiter.blocked(key, now))
    throw new HttpError(429, "too_many_attempts", "too many wrong PINs; wait a minute");
  const [row] = await ctx.db.select().from(staff).where(eq(staff.id, who.id)).limit(1);
  if (!(await verifyPin(input.pin, row?.pinHash))) {
    loginLimiter.fail(key, now);
    throw new HttpError(401, "invalid_credentials", "wrong PIN");
  }
  loginLimiter.reset(key);
  // The dashboard is not a device; this stand-in only carries the event and a gate name.
  const device: AuthedDevice = {
    id: "00000000-0000-0000-0000-000000000000",
    eventId,
    gate: "Dashboard",
    direction: "both",
    label: null,
    kind: "scanner",
  };
  const res = await claimTicket(
    ctx,
    device,
    {
      scan_id: randomUUID(),
      ticket_id: input.ticket_id,
      device_id: device.id,
      staff_id: who.id,
      gate: device.gate,
      scanned_at: now,
      override: true,
    },
    { dashboard: true },
  );
  return { result: res.result, admits_used: res.admits_used };
}

/** `GET /api/events/{id}/overrides`: manual admits and overrides, newest first, with a count per staff member. */
export async function listOverrides(
  ctx: AppContext,
  eventId: number,
): Promise<z.infer<typeof api.overridesResponse>> {
  await loadEvent(ctx.db, eventId);
  const rows = await ctx.db
    .select({ scan: scans, holder: tickets.holderName, staffName: staff.name })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .leftJoin(staff, eq(staff.id, scans.staffId))
    .where(and(eq(tickets.eventId, eventId), eq(scans.result, "override")))
    .orderBy(desc(scans.scannedAt), scans.id)
    .limit(500);
  const counts = await ctx.db
    .select({ id: scans.staffId, name: staff.name, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .leftJoin(staff, eq(staff.id, scans.staffId))
    .where(and(eq(tickets.eventId, eventId), eq(scans.result, "override")))
    .groupBy(scans.staffId, staff.name)
    .orderBy(sql`COUNT(*) DESC`);
  return {
    overrides: rows.map((r) => ({
      scan_id: r.scan.id,
      ticket_id: bytesToHex(r.scan.ticketId),
      holder_name: r.holder,
      staff_id: r.scan.staffId,
      staff_name: r.staffName,
      gate: r.scan.gate,
      device_id: r.scan.deviceId,
      scanned_at: r.scan.scannedAt,
      offline: r.scan.offline,
    })),
    by_staff: counts.map((c) => ({ staff_id: c.id, staff_name: c.name, count: Number(c.n) })),
  };
}

/** `POST /api/scans/{id}/review`: mark a conflict as looked at (or put it back). */
export async function reviewConflict(
  ctx: AppContext,
  who: AuthedStaff,
  scanId: string,
  reviewed: boolean,
): Promise<void> {
  const [scan] = await ctx.db.select().from(scans).where(eq(scans.id, scanId)).limit(1);
  if (!scan || !scan.conflict) throw notFound("conflict not found");
  await ctx.db
    .update(scans)
    .set(
      reviewed
        ? { reviewedAt: ctx.now(), reviewedBy: who.id }
        : { reviewedAt: null, reviewedBy: null },
    )
    .where(eq(scans.id, scanId));
}
