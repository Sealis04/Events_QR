import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { api, mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { assignments } from "./eventStaff";
import { loadEvent } from "./events";
import { badRequest, notFound } from "./http";

const { devices, scans, staff } = mysqlSchema;

async function loadDevice(ctx: AppContext, id: string) {
  const [row] = await ctx.db.select().from(devices).where(eq(devices.id, id)).limit(1);
  if (!row) throw notFound("device not found");
  return row;
}

/** `GET /api/events/{id}/devices`: the device panel as the VM sees it. */
export async function devicePanel(
  ctx: AppContext,
  eventId: number,
): Promise<z.infer<typeof api.devicePanelResponse>> {
  await loadEvent(ctx.db, eventId);
  const rows = await ctx.db.select().from(devices).where(eq(devices.eventId, eventId));
  const lastScans = await ctx.db
    .select({ id: scans.deviceId, at: sql<number>`MAX(${scans.scannedAt})` })
    .from(scans)
    .innerJoin(devices, eq(devices.id, scans.deviceId))
    .where(eq(devices.eventId, eventId))
    .groupBy(scans.deviceId);
  const lastScan = new Map(lastScans.map((r) => [r.id, Number(r.at)]));
  return {
    devices: rows.map((d) => ({
      id: d.id,
      kind: d.kind === "hub" ? "hub" : "scanner",
      label: d.label,
      gate: d.gate,
      direction: d.direction as "entry" | "exit" | "both",
      revoked: d.revoked,
      last_seen_at: d.lastSeenAt,
      outbox_size: d.outboxSize,
      battery_pct: d.batteryPct,
      last_scan_at: lastScan.get(d.id) ?? null,
    })),
    server_time: ctx.now(),
  };
}

/** `PATCH /api/devices/{id}`: phones pick the change up at their next sync. */
export async function updateDevice(
  ctx: AppContext,
  id: string,
  input: z.infer<typeof api.updateDeviceRequest>,
): Promise<void> {
  const device = await loadDevice(ctx, id);
  if (device.kind === "hub") throw badRequest("a venue hub has no gate");
  const event = await loadEvent(ctx.db, device.eventId);
  if (input.gate !== undefined && !event.gates.includes(input.gate))
    throw badRequest(`"${input.gate}" is not a gate of this event`);
  const set: Partial<typeof devices.$inferInsert> = {};
  if (input.gate !== undefined) set.gate = input.gate;
  if (input.direction !== undefined) set.direction = input.direction;
  if (input.label !== undefined) set.label = input.label;
  await ctx.db.update(devices).set(set).where(eq(devices.id, id));
}

/**
 * Lost-phone step: revoke the device (its token stops working and it wipes itself when it can) and,
 * with `rotate`, flag every staff member whose hash it may have held. We do not record what each
 * phone downloaded, so that is everyone ever tied to the event (issued tickets, added, or removed
 * since); each must pick a new PIN at their next login, and until then no phone gets their hash.
 */
export async function revokeDevice(
  ctx: AppContext,
  id: string,
  rotate: boolean,
): Promise<z.infer<typeof api.revokeDeviceResponse>> {
  const device = await loadDevice(ctx, id);
  await ctx.db.update(devices).set({ revoked: true }).where(eq(devices.id, id));
  if (!rotate) return { revoked: true, rotated_staff: [] };
  const related = [...(await assignments(ctx, device.eventId)).keys()];
  if (related.length === 0) return { revoked: true, rotated_staff: [] };
  await ctx.db.update(staff).set({ pinReset: "rotate" }).where(inArray(staff.id, related));
  const rows = await ctx.db
    .select({ id: staff.id, name: staff.name })
    .from(staff)
    .where(and(inArray(staff.id, related)));
  return { revoked: true, rotated_staff: rows };
}

/** `POST /api/devices/heartbeat`. */
export async function recordHeartbeat(
  ctx: AppContext,
  deviceId: string,
  input: z.infer<typeof api.heartbeatRequest>,
): Promise<void> {
  await ctx.db
    .update(devices)
    .set({
      outboxSize: input.outbox_size,
      batteryPct: input.battery_pct ?? null,
      reportedAt: ctx.now(),
    })
    .where(eq(devices.id, deviceId));
}
