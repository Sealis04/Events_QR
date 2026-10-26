import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { api, MAX_GATES, mysqlSchema, generateEventKey, type EntryMode } from "@events-qr/core";
import type { AppContext } from "./context";
import { type Db } from "./db";
import { badRequest, conflict, HttpError, notFound } from "./http";
import { decryptEventKey, encryptEventKey, b64 } from "./secrets";
import { offlineGateOnly } from "./settings";
import { isValidTimezone, localDayZero } from "./time";

const { events, ticketTypes, tickets, devices } = mysqlSchema;

export type EventRow = typeof events.$inferSelect;
export type TicketTypeRow = typeof ticketTypes.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

type EntryRuleInput = z.infer<typeof api.entryRule>;

export function ruleColumns(rule: EntryRuleInput | undefined): {
  entryMode: EntryMode;
  maxAdmits: number | null;
} {
  if (!rule) return { entryMode: "single", maxAdmits: null };
  return {
    entryMode: rule.mode,
    maxAdmits: rule.mode === "limited" ? (rule.max_admits ?? null) : null,
  };
}

export const eventConfig = (event: EventRow): { venue?: string; timezone?: string } =>
  (event.config ?? {}) as { venue?: string; timezone?: string };

export const eventTimezone = (ctx: AppContext, event: EventRow): string =>
  eventConfig(event).timezone ?? ctx.config.EVENT_TIMEZONE;

/** Unix seconds of 00:00 local on the event's first day (the origin of slot minutes). */
export const eventDayZero = (ctx: AppContext, event: EventRow): number =>
  localDayZero(event.startsAt, eventTimezone(ctx, event));

export const eventKeyOf = (ctx: AppContext, event: EventRow): Uint8Array =>
  decryptEventKey(event.encKeyRef, ctx.masterKey);

function checkGateMask(mask: number, gateCount: number, what: string): void {
  if (mask >> gateCount !== 0)
    throw badRequest(`${what}: gate_mask refers to a gate that does not exist`);
}

function checkSlots(slots: { start: number; end: number }[] | undefined): void {
  for (const s of slots ?? []) {
    if (s.start > 0xfffe || (s.end !== 0xffff && s.end <= s.start)) {
      throw badRequest("slot must start before it ends (end 65535 = until the event ends)");
    }
  }
}

function checkGates(gates: string[]): void {
  if (gates.length > MAX_GATES) throw badRequest(`at most ${MAX_GATES} gates`);
  if (new Set(gates.map((g) => g.toLowerCase())).size !== gates.length) {
    throw badRequest("gate names must be unique");
  }
}

type TypeInput = z.infer<typeof api.ticketTypeInput>;

function typeValues(
  eventId: number,
  t: TypeInput,
  gateCount: number,
): typeof ticketTypes.$inferInsert {
  checkGateMask(t.gate_mask ?? 0, gateCount, `ticket type ${t.name}`);
  checkSlots(t.slots);
  return {
    eventId,
    idx: t.idx,
    name: t.name,
    capacity: t.capacity ?? null,
    ...ruleColumns(t.entry_rule),
    gateMask: t.gate_mask ?? 0,
    slots: t.slots ?? null,
    earlyEntryMin: t.early_entry_min ?? 15,
  };
}

export async function createEvent(ctx: AppContext, input: z.infer<typeof api.createEventRequest>) {
  if (input.ends_at <= input.starts_at) throw badRequest("ends_at must be after starts_at");
  if (input.timezone && !isValidTimezone(input.timezone)) throw badRequest("unknown timezone");
  checkGates(input.gates);
  if (new Set(input.ticket_types.map((t) => t.idx)).size !== input.ticket_types.length) {
    throw badRequest("ticket type idx values must be unique");
  }
  const types = input.ticket_types.map((t) => typeValues(0, t, input.gates.length));

  const eventKey = generateEventKey();
  const config: Record<string, unknown> = {};
  if (input.venue) config.venue = input.venue;
  if (input.timezone) config.timezone = input.timezone;

  const id = await ctx.db.transaction(async (tx) => {
    const [res] = await tx.insert(events).values({
      name: input.name,
      startsAt: input.starts_at,
      endsAt: input.ends_at,
      encKeyRef: encryptEventKey(eventKey, ctx.masterKey),
      signKeyId: ctx.signer.currentKeyId,
      gates: input.gates,
      config,
    });
    const eventId = res.insertId;
    await tx.insert(ticketTypes).values(types.map((t) => ({ ...t, eventId })));
    return eventId;
  });
  return { id, sign_key_id: ctx.signer.currentKeyId };
}

export async function loadEvent(db: Db | Tx, eventId: number): Promise<EventRow> {
  const [row] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!row) throw notFound("event not found");
  return row;
}

export async function loadType(db: Db | Tx, eventId: number, idx: number): Promise<TicketTypeRow> {
  const [row] = await db
    .select()
    .from(ticketTypes)
    .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.idx, idx)))
    .limit(1);
  if (!row) throw notFound("ticket type not found");
  return row;
}

/** An event as the admin pages see it. Never includes key material. */
export function eventView(ctx: AppContext, event: EventRow, types: TicketTypeRow[]) {
  const config = eventConfig(event);
  return {
    id: event.id,
    name: event.name,
    venue: config.venue ?? null,
    timezone: eventTimezone(ctx, event),
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    sign_key_id: event.signKeyId,
    gates: event.gates,
    day_zero: eventDayZero(ctx, event),
    offline_gate_only: offlineGateOnly(event.config),
    ticket_types: types.map(typeView),
  };
}

export function typeView(t: TicketTypeRow) {
  return {
    idx: t.idx,
    name: t.name,
    capacity: t.capacity,
    issued: t.issued,
    entry_rule: { mode: t.entryMode as EntryMode, max_admits: t.maxAdmits },
    gate_mask: t.gateMask,
    slots: t.slots ?? [],
    early_entry_min: t.earlyEntryMin,
  };
}

export async function getEventView(ctx: AppContext, eventId: number) {
  const event = await loadEvent(ctx.db, eventId);
  const types = await ctx.db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(asc(ticketTypes.idx));
  return eventView(ctx, event, types);
}

/** The events list with what its cards show: types, issued vs capacity, who is inside, how many phones. */
export async function listEvents(ctx: AppContext) {
  const rows = await ctx.db.select().from(events).orderBy(desc(events.startsAt)).limit(500);
  const typeRows = await ctx.db
    .select({
      eventId: ticketTypes.eventId,
      types: sql<number>`COUNT(*)`,
      issued: sql<number>`COALESCE(SUM(${ticketTypes.issued}), 0)`,
      capacity: sql<number>`COALESCE(SUM(${ticketTypes.capacity}), 0)`,
      unlimited: sql<number>`COALESCE(SUM(${ticketTypes.capacity} IS NULL), 0)`,
    })
    .from(ticketTypes)
    .groupBy(ticketTypes.eventId);
  const insideRows = await ctx.db
    .select({ eventId: tickets.eventId, n: sql<number>`COUNT(*)` })
    .from(tickets)
    .where(eq(tickets.inside, true))
    .groupBy(tickets.eventId);
  const deviceRows = await ctx.db
    .select({ eventId: devices.eventId, n: sql<number>`COUNT(*)` })
    .from(devices)
    .where(and(eq(devices.revoked, false), eq(devices.kind, "scanner")))
    .groupBy(devices.eventId);
  return rows.map((e) => {
    const t = typeRows.find((r) => r.eventId === e.id);
    return {
      id: e.id,
      name: e.name,
      venue: eventConfig(e).venue ?? null,
      timezone: eventTimezone(ctx, e),
      starts_at: e.startsAt,
      ends_at: e.endsAt,
      gates: e.gates,
      ticket_type_count: Number(t?.types ?? 0),
      issued: Number(t?.issued ?? 0),
      // null when any type has no limit: there is no total to show a bar against.
      capacity: t && Number(t.unlimited) === 0 && Number(t.types) > 0 ? Number(t.capacity) : null,
      inside: Number(insideRows.find((r) => r.eventId === e.id)?.n ?? 0),
      device_count: Number(deviceRows.find((r) => r.eventId === e.id)?.n ?? 0),
    };
  });
}

async function hasTickets(db: Db | Tx, eventId: number): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(tickets)
    .where(eq(tickets.eventId, eventId))
    .limit(1);
  return !!row;
}

export async function updateEvent(
  ctx: AppContext,
  eventId: number,
  input: z.infer<typeof api.updateEventRequest>,
) {
  return ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update")
      .limit(1);
    if (!event) throw notFound("event not found");
    const started = await hasTickets(tx, eventId);

    const startsAt = input.starts_at ?? event.startsAt;
    const endsAt = input.ends_at ?? event.endsAt;
    if (endsAt <= startsAt) throw badRequest("ends_at must be after starts_at");
    if (started && startsAt !== event.startsAt) {
      throw conflict(
        "tickets_exist",
        "starts_at cannot change once tickets exist (slot times are relative to it)",
      );
    }

    const set: Partial<typeof events.$inferInsert> = { startsAt, endsAt };
    if (input.name) set.name = input.name;
    if (input.gates) {
      checkGates(input.gates);
      const old = event.gates;
      if (started && !old.every((g, i) => input.gates![i] === g)) {
        throw conflict("gates_append_only", "gates can only be appended once tickets exist");
      }
      const [{ top } = { top: 0 }] = await tx
        .select({ top: sql<number>`COALESCE(MAX(${ticketTypes.gateMask}), 0)` })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId));
      if (Number(top) >> input.gates.length !== 0) {
        throw conflict("gate_in_use", "a ticket type still refers to a gate you are removing");
      }
      set.gates = input.gates;
    }
    if (input.venue !== undefined || input.offline_gate_only !== undefined) {
      const config = { ...(event.config ?? {}) } as Record<string, unknown>;
      if (input.venue !== undefined) {
        if (input.venue === null || input.venue === "") delete config.venue;
        else config.venue = input.venue;
      }
      if (input.offline_gate_only !== undefined) {
        if (input.offline_gate_only) config.offline_gate_only = true;
        else delete config.offline_gate_only;
      }
      set.config = config;
    }
    await tx.update(events).set(set).where(eq(events.id, eventId));
  });
}

export async function addTicketType(
  ctx: AppContext,
  eventId: number,
  input: z.infer<typeof api.addTicketTypeRequest>,
) {
  return ctx.db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(events)
      .where(eq(events.id, eventId))
      .for("update")
      .limit(1);
    if (!event) throw notFound("event not found");
    let idx = input.idx;
    if (idx === undefined) {
      const [{ top } = { top: -1 }] = await tx
        .select({ top: sql<number>`COALESCE(MAX(${ticketTypes.idx}), -1)` })
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId));
      idx = Number(top) + 1;
      if (idx > 255)
        throw conflict("too_many_types", "ticket_type is one byte; no free index left");
    } else {
      const [taken] = await tx
        .select({ idx: ticketTypes.idx })
        .from(ticketTypes)
        .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.idx, idx)));
      if (taken) throw conflict("type_exists", `ticket type ${idx} already exists`);
    }
    await tx.insert(ticketTypes).values(typeValues(eventId, { ...input, idx }, event.gates.length));
    return idx;
  });
}

export async function updateTicketType(
  ctx: AppContext,
  eventId: number,
  idx: number,
  input: z.infer<typeof api.updateTicketTypeRequest>,
) {
  await ctx.db.transaction(async (tx) => {
    const event = await loadEvent(tx, eventId);
    const [type] = await tx
      .select()
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.idx, idx)))
      .for("update")
      .limit(1);
    if (!type) throw notFound("ticket type not found");

    const set: Partial<typeof ticketTypes.$inferInsert> = {};
    if (input.name !== undefined) set.name = input.name;
    if (input.capacity !== undefined) {
      if (input.capacity !== null && input.capacity < type.issued) {
        throw conflict(
          "below_issued",
          `capacity cannot be below the ${type.issued} tickets already issued`,
        );
      }
      set.capacity = input.capacity;
    }
    if (input.entry_rule !== undefined) Object.assign(set, ruleColumns(input.entry_rule));
    if (input.gate_mask !== undefined) {
      checkGateMask(input.gate_mask, event.gates.length, "gate_mask");
      set.gateMask = input.gate_mask;
    }
    if (input.slots !== undefined) {
      checkSlots(input.slots);
      set.slots = input.slots;
    }
    if (input.early_entry_min !== undefined) set.earlyEntryMin = input.early_entry_min;
    if (Object.keys(set).length === 0) throw badRequest("nothing to update");
    await tx
      .update(ticketTypes)
      .set(set)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.idx, idx)));
  });
}

/** Key material for an enrolled device: the event key, every public signing key, and event facts. */
export function keyBundle(
  ctx: AppContext,
  event: EventRow,
  types: TicketTypeRow[],
  cloudUrl?: string,
): z.infer<typeof api.keyBundle> {
  return {
    event_id: event.id,
    event_key: b64(eventKeyOf(ctx, event)),
    public_keys: Object.fromEntries(
      [...ctx.signer.publicKeys()].map(([id, key]) => [String(id), b64(key)]),
    ),
    gates: event.gates,
    starts_at: event.startsAt,
    ends_at: event.endsAt,
    day_zero: eventDayZero(ctx, event),
    ticket_types: scannerTypes(types),
    ...((cloudUrl ?? ctx.config.PUBLIC_URL)
      ? { cloud_url: cloudUrl ?? ctx.config.PUBLIC_URL }
      : {}),
  };
}

export const scannerTypes = (types: TicketTypeRow[]) =>
  types.map((t) => ({ idx: t.idx, name: t.name, early_entry_min: t.earlyEntryMin }));

export async function loadTypes(db: Db | Tx, eventId: number): Promise<TicketTypeRow[]> {
  return db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, eventId))
    .orderBy(asc(ticketTypes.idx));
}

export { HttpError };
