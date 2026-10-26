/**
 * The dashboard on a venue hub (M6): the read-only views an organiser needs with the internet
 * down (event, stats, device panel, conflict feed, attendee search, overrides audit) plus the one
 * write that must work there, a supervisor's manual admit. Same URLs and JSON shapes as the VM's
 * routes (src/server), so the same UI code runs against either; the route files pick by mode.
 * Issuance, event setup, cancellation and conflict review stay VM-only.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import { api, bytesToHex, shortTicketId, sqliteSchema } from "@events-qr/core";
import {
  clearedSessionCookie,
  loginIpLimiter,
  loginLimiter,
  sessionCookie,
  verifyPin,
} from "../server/auth";
import { HttpError, json, notFound } from "../server/errors";
import { offlineGateOnly } from "../server/settings";
import { searchTerms, ticketListQuery } from "../server/ticketQuery";
import { claimTicket } from "./claim";
import type { HubContext } from "./context";
import { hubRoute } from "./http";
import { createHubSession } from "./session";
import { getBundle, getEventId, getLink, getState } from "./state";

const { events, ticketTypes, tickets, scans, devices, staff } = sqliteSchema;

const ADMIT_RESULTS = ["admitted", "override"];

function requireEvent(ctx: HubContext, idParam: string | undefined) {
  const id = getEventId(ctx);
  if (id === undefined || String(id) !== idParam) throw notFound("event not found");
  const event = ctx.db.select().from(events).where(eq(events.id, id)).get();
  if (!event) throw notFound("event not found");
  return event;
}

const idOf = (url: string): string | undefined => new URL(url).pathname.split("/")[3];

/** Dashboard login on the hub: supervisors and admins only, checked against the staff the VM sent. */
export const login = hubRoute(
  { access: "public", body: api.loginRequest },
  async ({ req, ctx, body }) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `${ip}|${body.name.toLowerCase()}`;
    const now = ctx.now();
    if (loginLimiter.blocked(key, now) || loginIpLimiter.blocked(ip, now)) {
      throw new HttpError(429, "too_many_attempts", "too many failed logins; wait a minute");
    }
    const row = ctx.db
      .select()
      .from(staff)
      .where(sql`lower(${staff.name}) = ${body.name.toLowerCase()}`)
      .get();
    if (!(await verifyPin(body.pin, row?.pinHash || undefined)) || !row) {
      loginLimiter.fail(key, now);
      loginIpLimiter.fail(ip, now);
      throw new HttpError(401, "invalid_credentials", "wrong name or PIN");
    }
    loginLimiter.reset(key);
    const privileged = row.role === "supervisor" || row.role === "admin";
    const headers: Record<string, string> = {};
    // Phones only want the answer. The dashboard gets a session, and only for supervisors and admins.
    if (body.for !== "scanner" && privileged)
      headers["set-cookie"] = sessionCookie(ctx, createHubSession(ctx, row.id));
    return json({ id: row.id, name: row.name, role: row.role, pin_reset: null }, 200, headers);
  },
);

export const logout = hubRoute({ access: "public" }, ({ ctx }) =>
  json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(ctx) }),
);

export const me = hubRoute({ access: { staff: "supervisor" } }, ({ staff: who }) =>
  json({ id: who.id, name: who.name, role: who.role, pin_reset: null, mode: "hub" }),
);

function typeView(t: typeof ticketTypes.$inferSelect) {
  return {
    idx: t.idx,
    name: t.name,
    capacity: t.capacity,
    issued: t.issued,
    entry_rule: { mode: t.entryMode, max_admits: t.maxAdmits },
    gate_mask: t.gateMask,
    slots: t.slots ?? [],
    early_entry_min: t.earlyEntryMin,
  };
}

const eventSummary = (ctx: HubContext) => {
  const id = getEventId(ctx);
  const event =
    id === undefined ? undefined : ctx.db.select().from(events).where(eq(events.id, id)).get();
  return event;
};

export const eventList = hubRoute({ access: { staff: "supervisor" } }, ({ ctx }) => {
  const e = eventSummary(ctx);
  if (!e) return json([]);
  const config = (e.config ?? {}) as { venue?: string; timezone?: string };
  const types = ctx.db.select().from(ticketTypes).where(eq(ticketTypes.eventId, e.id)).all();
  const [inside] = ctx.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(and(eq(tickets.eventId, e.id), eq(tickets.inside, true)))
    .all();
  const [phones] = ctx.db
    .select({ n: sql<number>`COUNT(*)` })
    .from(devices)
    .where(and(eq(devices.eventId, e.id), eq(devices.revoked, false), eq(devices.kind, "scanner")))
    .all();
  return json([
    {
      id: e.id,
      name: e.name,
      venue: config.venue ?? null,
      timezone: config.timezone ?? null,
      starts_at: e.startsAt,
      ends_at: e.endsAt,
      gates: e.gates,
      ticket_type_count: types.length,
      issued: types.reduce((n, t) => n + t.issued, 0),
      capacity:
        types.length > 0 && types.every((t) => t.capacity !== null)
          ? types.reduce((n, t) => n + (t.capacity ?? 0), 0)
          : null,
      inside: Number(inside?.n ?? 0),
      device_count: Number(phones?.n ?? 0),
    },
  ]);
});

export const eventView = hubRoute({ access: { staff: "supervisor" } }, ({ req, ctx }) => {
  const event = requireEvent(ctx, idOf(req.url));
  const config = (event.config ?? {}) as { venue?: string; timezone?: string };
  const types = ctx.db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, event.id))
    .orderBy(asc(ticketTypes.idx))
    .all();
  return json({
    id: event.id,
    name: event.name,
    venue: config.venue ?? null,
    timezone: config.timezone ?? "UTC",
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    sign_key_id: event.signKeyId,
    gates: event.gates,
    day_zero: getBundle(ctx)?.day_zero ?? event.startsAt,
    offline_gate_only: offlineGateOnly(event.config),
    ticket_types: types.map(typeView),
  });
});

export const stats = hubRoute({ access: { staff: "supervisor" } }, ({ req, ctx }) => {
  const event = requireEvent(ctx, idOf(req.url));
  const entries = and(
    eq(tickets.eventId, event.id),
    eq(scans.direction, "entry"),
    inArray(scans.result, ADMIT_RESULTS),
  );
  const byGate = ctx.db
    .select({ gate: scans.gate, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(scans.gate)
    .all();
  const byType = ctx.db
    .select({ type: tickets.ticketType, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(tickets.ticketType)
    .all();
  const inside =
    ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(tickets)
      .where(and(eq(tickets.eventId, event.id), eq(tickets.inside, true)))
      .get()?.n ?? 0;
  const conflicts =
    ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(scans)
      .innerJoin(tickets, eq(scans.ticketId, tickets.id))
      .where(and(eq(tickets.eventId, event.id), eq(scans.conflict, true)))
      .get()?.n ?? 0;
  const openConflicts =
    ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(scans)
      .innerJoin(tickets, eq(scans.ticketId, tickets.id))
      .where(and(eq(tickets.eventId, event.id), eq(scans.conflict, true), isNull(scans.reviewedAt)))
      .get()?.n ?? 0;
  const left =
    ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(tickets)
      .where(
        and(
          eq(tickets.eventId, event.id),
          eq(tickets.inside, false),
          gt(tickets.admitsUsed, 0),
          sql`${tickets.status} <> 'cancelled'`,
        ),
      )
      .get()?.n ?? 0;
  const lastMinute =
    ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(scans)
      .innerJoin(tickets, eq(scans.ticketId, tickets.id))
      .where(and(entries, gte(scans.scannedAt, ctx.now() - 60)))
      .get()?.n ?? 0;
  const busiest = ctx.db
    .select({ minute: sql<number>`(${scans.scannedAt} / 60) * 60`, n: sql<number>`COUNT(*)` })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(entries)
    .groupBy(sql`${scans.scannedAt} / 60`)
    .orderBy(sql`COUNT(*) DESC`, sql`${scans.scannedAt} / 60`)
    .limit(1)
    .get();
  const lastSync = getState(ctx, "last_cloud_sync_at");
  const lastError = getState(ctx, "last_cloud_error");
  const since = ctx.now() - 3600;
  const perMinute = ctx.db
    .select({
      minute: sql<number>`(${scans.scannedAt} / 60) * 60`,
      n: sql<number>`COUNT(*)`,
    })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .where(and(entries, gte(scans.scannedAt, since)))
    .groupBy(sql`${scans.scannedAt} / 60`)
    .orderBy(sql`${scans.scannedAt} / 60`)
    .all();
  const body: z.infer<typeof api.eventStatsResponse> = {
    total_admitted: byGate.reduce((sum, r) => sum + Number(r.n), 0),
    inside: Number(inside),
    by_gate: Object.fromEntries(byGate.map((r) => [r.gate, Number(r.n)])),
    by_ticket_type: Object.fromEntries(byType.map((r) => [String(r.type), Number(r.n)])),
    conflicts: Number(conflicts),
    scans_per_minute: perMinute.map((r) => ({ minute: Number(r.minute), count: Number(r.n) })),
    left: Number(left),
    last_minute: Number(lastMinute),
    busiest: busiest ? { minute: Number(busiest.minute), count: Number(busiest.n) } : null,
    open_conflicts: Number(openConflicts),
    hub: {
      // The VM answered at the last sync unless an error was recorded after it.
      online: !lastError,
      last_sync_at: lastSync ? Number(lastSync) : null,
      last_error: lastError ?? null,
    },
  };
  return json(body);
});

export const devicesPanel = hubRoute({ access: { staff: "supervisor" } }, ({ req, ctx }) => {
  const event = requireEvent(ctx, idOf(req.url));
  const rows = ctx.db.select().from(devices).where(eq(devices.eventId, event.id)).all();
  const lastScans = ctx.db
    .select({ id: scans.deviceId, at: sql<number>`MAX(${scans.scannedAt})` })
    .from(scans)
    .groupBy(scans.deviceId)
    .all();
  const lastScan = new Map(lastScans.map((r) => [r.id, Number(r.at)]));
  const body: z.infer<typeof api.devicePanelResponse> = {
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
  return json(body);
});
export { devicesPanel as devices };

export const heartbeat = hubRoute(
  { access: "device", body: api.heartbeatRequest },
  ({ ctx, device, body }) => {
    ctx.db
      .update(devices)
      .set({
        outboxSize: body.outbox_size,
        batteryPct: body.battery_pct ?? null,
        reportedAt: ctx.now(),
      })
      .where(eq(devices.id, device.id))
      .run();
    return json({ ok: true });
  },
);

export const conflicts = hubRoute(
  { access: { staff: "supervisor" }, query: api.conflictsQuery },
  ({ req, ctx, query }) => {
    const event = requireEvent(ctx, idOf(req.url));
    const where = and(
      eq(tickets.eventId, event.id),
      eq(scans.conflict, true),
      query.before !== undefined ? sql`${scans.scannedAt} < ${query.before}` : undefined,
    );
    const rows = ctx.db
      .select({ scan: scans, holder: tickets.holderName, status: tickets.status })
      .from(scans)
      .innerJoin(tickets, eq(scans.ticketId, tickets.id))
      .where(where)
      .orderBy(desc(scans.scannedAt), scans.id)
      .limit(query.limit)
      .all();
    const total =
      ctx.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(scans)
        .innerJoin(tickets, eq(scans.ticketId, tickets.id))
        .where(and(eq(tickets.eventId, event.id), eq(scans.conflict, true)))
        .get()?.n ?? 0;

    const deviceLabels = new Map(
      ctx.db
        .select({ id: devices.id, label: devices.label })
        .from(devices)
        .all()
        .map((d) => [d.id, d.label]),
    );
    const staffNames = new Map(
      ctx.db
        .select({ id: staff.id, name: staff.name })
        .from(staff)
        .all()
        .map((s) => [s.id, s.name]),
    );
    const firsts = new Map<string, typeof scans.$inferSelect>();
    const ids = [...new Set(rows.map((r) => r.scan.ticketId))];
    if (ids.length) {
      const admits = ctx.db
        .select()
        .from(scans)
        .where(
          and(
            inArray(scans.ticketId, ids),
            eq(scans.direction, "entry"),
            inArray(scans.result, ADMIT_RESULTS),
            eq(scans.conflict, false),
          ),
        )
        .orderBy(scans.scannedAt, scans.id)
        .all();
      for (const f of admits) {
        const key = bytesToHex(f.ticketId);
        if (!firsts.has(key)) firsts.set(key, f);
      }
    }
    const body: z.infer<typeof api.conflictsResponse> = {
      conflicts: rows.map(({ scan: s, holder, status }) => {
        const first = firsts.get(bytesToHex(s.ticketId));
        return {
          scan_id: s.id,
          ticket_id: bytesToHex(s.ticketId),
          holder_name: holder,
          gate: s.gate,
          device_id: s.deviceId,
          scanned_at: s.scannedAt,
          received_at: s.receivedAt,
          offline: s.offline,
          canonical: first ? { gate: first.gate, scanned_at: first.scannedAt } : null,
          ticket_status: status as "valid" | "used_up" | "cancelled",
          staff_id: s.staffId,
          staff_name: s.staffId ? (staffNames.get(s.staffId) ?? null) : null,
          device_label: s.deviceId ? (deviceLabels.get(s.deviceId) ?? null) : null,
          canonical_detail: first
            ? {
                gate: first.gate,
                scanned_at: first.scannedAt,
                offline: first.offline,
                device_id: first.deviceId,
                device_label: first.deviceId ? (deviceLabels.get(first.deviceId) ?? null) : null,
                staff_name: first.staffId ? (staffNames.get(first.staffId) ?? null) : null,
              }
            : null,
          reviewed_at: s.reviewedAt,
        };
      }),
      total: Number(total),
    };
    return json(body);
  },
);

/** Attendee search: name or the last hex characters of the ticket id (emails are not mirrored to the hub). */
export const ticketList = hubRoute(
  { access: { staff: "supervisor" }, query: ticketListQuery },
  ({ req, ctx, query }) => {
    const event = requireEvent(ctx, idOf(req.url));
    const terms = searchTerms(query.q);
    const nameLike = terms ? sql`${tickets.holderName} LIKE ${terms.like} ESCAPE '\\'` : undefined;
    const search = terms
      ? terms.hex
        ? or(nameLike, sql`hex(${tickets.id}) LIKE ${"%" + terms.hex}`)
        : nameLike
      : undefined;
    const notCancelled = sql`${tickets.status} <> 'cancelled'`;
    const state =
      query.state === "cancelled"
        ? eq(tickets.status, "cancelled")
        : query.state === "inside"
          ? and(notCancelled, eq(tickets.inside, true))
          : query.state === "left"
            ? and(notCancelled, eq(tickets.inside, false), gt(tickets.admitsUsed, 0))
            : query.state === "not_in"
              ? and(notCancelled, eq(tickets.admitsUsed, 0))
              : undefined;
    const where = and(
      eq(tickets.eventId, event.id),
      search,
      query.status ? eq(tickets.status, query.status) : undefined,
      query.type !== undefined ? eq(tickets.ticketType, query.type) : undefined,
      state,
    );
    const d = query.dir === "desc" ? sql`DESC` : sql`ASC`;
    const key =
      query.sort === "holder"
        ? sql`${tickets.holderName}`
        : query.sort === "type"
          ? sql`${tickets.ticketType}`
          : query.sort === "state"
            ? sql`CASE WHEN ${tickets.status} = 'cancelled' THEN 3 WHEN ${tickets.inside} = 1 THEN 1 WHEN ${tickets.admitsUsed} > 0 THEN 2 ELSE 0 END`
            : sql`${tickets.issuedAt}`;
    const rows = ctx.db
      .select()
      .from(tickets)
      .where(where)
      .orderBy(sql`${key} ${d}`, asc(tickets.issuedAt), asc(tickets.id))
      .limit(query.limit)
      .offset(query.offset)
      .all();
    const total =
      ctx.db
        .select({ n: sql<number>`COUNT(*)` })
        .from(tickets)
        .where(where)
        .get()?.n ?? 0;
    return json({
      total: Number(total),
      tickets: rows.map((r) => ({
        ticket_id: bytesToHex(r.id),
        short_id: shortTicketId({ ticketId: r.id }),
        holder_name: r.holderName,
        holder_email: null,
        ticket_type: r.ticketType,
        status: r.status,
        admits_used: r.admitsUsed,
        inside: r.inside,
        issued_at: r.issuedAt,
        updated_at: r.updatedAt,
      })),
    });
  },
);

export const overrides = hubRoute({ access: { staff: "supervisor" } }, ({ req, ctx }) => {
  const event = requireEvent(ctx, idOf(req.url));
  const rows = ctx.db
    .select({ scan: scans, holder: tickets.holderName, staffName: staff.name })
    .from(scans)
    .innerJoin(tickets, eq(scans.ticketId, tickets.id))
    .leftJoin(staff, eq(staff.id, scans.staffId))
    .where(and(eq(tickets.eventId, event.id), eq(scans.result, "override")))
    .orderBy(desc(scans.scannedAt), scans.id)
    .limit(500)
    .all();
  const counts = new Map<
    string,
    { staff_id: string | null; staff_name: string | null; count: number }
  >();
  for (const r of rows) {
    const k = r.scan.staffId ?? "";
    const cur = counts.get(k) ?? { staff_id: r.scan.staffId, staff_name: r.staffName, count: 0 };
    cur.count += 1;
    counts.set(k, cur);
  }
  const body: z.infer<typeof api.overridesResponse> = {
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
    by_staff: [...counts.values()].sort((a, b) => b.count - a.count),
  };
  return json(body);
});

/** The hub is a device of its event at the VM; scans it records itself carry its id (the VM's upload check wants a known device). */
function dashboardDevice(ctx: HubContext, eventId: number) {
  const link = getLink(ctx);
  if (!link) throw new HttpError(503, "not_linked", "this hub is not linked to a VM yet");
  ctx.db
    .insert(devices)
    .values({
      id: link.deviceId,
      eventId,
      label: "Hub dashboard",
      gate: "Dashboard",
      direction: "both",
      tokenHash: "-",
      kind: "hub",
    })
    .onConflictDoNothing()
    .run();
  return {
    id: link.deviceId,
    eventId,
    gate: "Dashboard",
    direction: "both",
    label: "Hub dashboard",
    kind: "scanner" as const,
  };
}

/** Manual admit from attendee search: the supervisor's PIN is asked again; logged as an `override`. */
export const admit = hubRoute(
  { access: { staff: "supervisor" }, body: api.manualAdmitRequest },
  async ({ req, ctx, staff: who, body }) => {
    const event = requireEvent(ctx, idOf(req.url));
    const key = `admit|${who.id}`;
    const now = ctx.now();
    if (loginLimiter.blocked(key, now))
      throw new HttpError(429, "too_many_attempts", "too many wrong PINs; wait a minute");
    const row = ctx.db.select().from(staff).where(eq(staff.id, who.id)).get();
    if (!(await verifyPin(body.pin, row?.pinHash || undefined))) {
      loginLimiter.fail(key, now);
      throw new HttpError(401, "invalid_credentials", "wrong PIN");
    }
    loginLimiter.reset(key);
    const device = dashboardDevice(ctx, event.id);
    const res = await claimTicket(ctx, device, {
      scan_id: randomUUID(),
      ticket_id: body.ticket_id,
      device_id: device.id,
      staff_id: who.id,
      gate: device.gate,
      scanned_at: now,
      override: true,
    });
    return json({ result: res.result, admits_used: res.admits_used });
  },
);
