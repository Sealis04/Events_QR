import { and, eq, inArray, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  api,
  bytesToHex,
  encodeEntryRule,
  hexToBytes,
  mysqlSchema,
  shortTicketId,
  SLOT_NONE,
  type EntryMode,
  type TicketPayload,
} from "@events-qr/core";
import type { AppContext } from "./context";
import type { Db } from "./db";
import { affectedRows, isDuplicate, toBuffer } from "./dbutil";
import { badRequest, conflict, HttpError, notFound } from "./http";
import {
  eventDayZero,
  eventKeyOf,
  loadEvent,
  loadType,
  ruleColumns,
  type EventRow,
  type TicketTypeRow,
} from "./events";
import { renderQr } from "./qr";
import { sha256Hex } from "./secrets";

const { tickets, ticketTypes, emailQueue, idempotencyKeys } = mysqlSchema;

export type TicketRow = typeof tickets.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CreateRequest = z.infer<typeof api.createTicketsRequest>;
export type IssuedTicket = z.infer<typeof api.createTicketsResponse>["tickets"][number];

const idHex = (row: Pick<TicketRow, "id">): string => bytesToHex(row.id);

/** Slot minutes <-> stored Unix seconds. `slot_end` NULL with a start means "until the event ends". */
function payloadFor(ctx: AppContext, event: EventRow, row: TicketRow): TicketPayload {
  const dayZero = eventDayZero(ctx, event);
  const minute = (unix: number) => Math.round((unix - dayZero) / 60);
  const hasSlot = row.slotStart !== null;
  return {
    version: 1,
    eventId: event.id,
    ticketId: new Uint8Array(row.id),
    ticketType: row.ticketType,
    issuedAt: row.issuedAt,
    keyId: event.signKeyId,
    entryRule: encodeEntryRule(
      row.entryMode as EntryMode,
      row.entryMode === "limited" ? row.maxAdmits : null,
    ),
    gateMask: row.gateMask,
    slotStart: hasSlot ? minute(row.slotStart!) : SLOT_NONE,
    slotEnd: hasSlot && row.slotEnd !== null ? minute(row.slotEnd) : SLOT_NONE,
  };
}

/** Rebuilds the ticket's token from stored fields and its nonce: byte-identical every time. */
export function tokenForRow(ctx: AppContext, event: EventRow, row: TicketRow): Promise<string> {
  return ctx.signer.mint(
    payloadFor(ctx, event, row),
    eventKeyOf(ctx, event),
    new Uint8Array(row.tokenNonce),
  );
}

export async function toIssued(
  ctx: AppContext,
  event: EventRow,
  row: TicketRow,
  render = true,
): Promise<IssuedTicket> {
  const token = await tokenForRow(ctx, event, row);
  const qr = render ? await renderQr(token) : undefined;
  return {
    ticket_id: idHex(row),
    holder_name: row.holderName,
    ticket_type: row.ticketType,
    short_id: shortTicketId({ ticketId: row.id }),
    token,
    qr_png: qr?.pngDataUrl ?? "data:image/png;base64,",
    qr_svg: qr?.svg ?? "<svg/>",
  };
}

export async function loadTicket(db: Db | Tx, idHexValue: string): Promise<TicketRow> {
  const [row] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, toBuffer(hexToBytes(idHexValue))))
    .limit(1);
  if (!row) throw notFound("ticket not found");
  return row;
}

export interface Issuer {
  id: string;
  role: string;
}

interface Resolved {
  entryMode: EntryMode;
  maxAdmits: number | null;
  gateMask: number;
  slotStart: number | null;
  slotEnd: number | null;
}

/** Applies the ticket type's defaults and the optional per-ticket overrides. */
function resolveRules(
  ctx: AppContext,
  event: EventRow,
  type: TicketTypeRow,
  req: CreateRequest,
  issuer: Issuer,
): Resolved {
  let { entryMode, maxAdmits } = {
    entryMode: type.entryMode as EntryMode,
    maxAdmits: type.maxAdmits,
  };
  if (req.entry_rule) {
    const override = ruleColumns(req.entry_rule);
    if (override.entryMode !== entryMode || override.maxAdmits !== maxAdmits) {
      if (issuer.role === "staff") {
        throw new HttpError(
          403,
          "forbidden",
          "only a supervisor can change the entry rule of a ticket",
        );
      }
      ({ entryMode, maxAdmits } = override);
    }
  }
  const gateMask = req.gate_mask ?? type.gateMask;
  if (gateMask >> event.gates.length !== 0)
    throw badRequest("gate_mask refers to a gate that does not exist");

  let slotStart: number | null = null;
  let slotEnd: number | null = null;
  if (req.slot) {
    const { start, end } = req.slot;
    if (start > 0xfffe || (end !== 0xffff && end <= start))
      throw badRequest("slot must start before it ends");
    const dayZero = eventDayZero(ctx, event);
    slotStart = dayZero + start * 60;
    slotEnd = end === 0xffff ? null : dayZero + end * 60;
  }
  return {
    entryMode,
    maxAdmits: entryMode === "single" ? 1 : maxAdmits,
    gateMask,
    slotStart,
    slotEnd,
  };
}

function holderNames(type: TicketTypeRow, req: CreateRequest): (string | null)[] {
  const n = req.quantity;
  if (n === 1) {
    if (!req.holder_name) throw badRequest("holder_name is required");
    return [req.holder_name];
  }
  const width = String(n).length;
  return Array.from({ length: n }, (_, i) => {
    const number = String(i + 1).padStart(Math.max(2, width), "0");
    return `${req.holder_name ?? type.name} ${number}`;
  });
}

class Replay extends Error {}

export interface IssueResult {
  created: boolean;
  tickets: IssuedTicket[];
}

/**
 * The generator. In one transaction: record the idempotency key, take capacity with the spec's
 * conditional UPDATE (checking rows affected), insert the tickets and queue emails. Retrying a
 * key returns the same tickets.
 */
export async function issueTickets(
  ctx: AppContext,
  eventId: number,
  req: CreateRequest,
  issuer: Issuer,
  options: { render?: boolean } = {},
): Promise<IssueResult> {
  const event = await loadEvent(ctx.db, eventId);
  const type = await loadType(ctx.db, eventId, req.ticket_type);
  const rules = resolveRules(ctx, event, type, req, issuer);
  const names = holderNames(type, req);
  const render = options.render ?? true;

  const requestHash = sha256Hex(
    JSON.stringify([
      eventId,
      req.ticket_type,
      req.quantity,
      req.holder_name ?? null,
      req.holder_email ?? null,
      rules,
      req.note ?? null,
    ]),
  );

  const now = ctx.now();
  const rows: (typeof tickets.$inferInsert)[] = names.map((holderName) => ({
    id: toBuffer(randomBytes(16)),
    eventId,
    ticketType: req.ticket_type,
    holderName,
    holderEmail: req.holder_email ?? null,
    note: req.note ?? null,
    issuedBy: issuer.id,
    tokenNonce: toBuffer(randomBytes(12)),
    entryMode: rules.entryMode,
    maxAdmits: rules.maxAdmits,
    gateMask: rules.gateMask,
    slotStart: rules.slotStart,
    slotEnd: rules.slotEnd,
    issuedAt: now,
    updatedAt: now,
  }));

  try {
    await ctx.db.transaction(async (tx) => {
      try {
        await tx.insert(idempotencyKeys).values({
          eventId,
          key: req.idempotency_key,
          requestHash,
          ticketIds: rows.map((r) => bytesToHex(r.id as Uint8Array)),
          createdAt: now,
        });
      } catch (err) {
        if (isDuplicate(err)) throw new Replay();
        throw err;
      }
      await takeCapacity(tx, eventId, type, req.quantity);
      await tx.insert(tickets).values(rows);
      if (req.holder_email) {
        await tx.insert(emailQueue).values(
          rows.map((r) => ({
            ticketId: r.id as Uint8Array,
            toEmail: req.holder_email!,
            nextAttemptAt: now,
            createdAt: now,
          })),
        );
      }
    });
  } catch (err) {
    if (err instanceof Replay) return replay(ctx, event, req.idempotency_key, requestHash, render);
    throw err;
  }

  const stored = await loadByIds(
    ctx.db,
    rows.map((r) => bytesToHex(r.id as Uint8Array)),
  );
  return {
    created: true,
    tickets: await Promise.all(stored.map((row) => toIssued(ctx, event, row, render))),
  };
}

/**
 * `UPDATE ticket_types SET issued = issued + n WHERE ... AND (capacity IS NULL OR issued + n <= capacity)`.
 * No row changed means sold out: nothing is created.
 */
async function takeCapacity(
  tx: Tx,
  eventId: number,
  type: TicketTypeRow,
  quantity: number,
): Promise<void> {
  const [result] = await tx
    .update(ticketTypes)
    .set({ issued: sql`${ticketTypes.issued} + ${quantity}` })
    .where(
      and(
        eq(ticketTypes.eventId, eventId),
        eq(ticketTypes.idx, type.idx),
        sql`(${ticketTypes.capacity} IS NULL OR ${ticketTypes.issued} + ${quantity} <= ${ticketTypes.capacity})`,
      ),
    );
  if (affectedRows(result) !== 1) {
    const [now] = await tx
      .select({ capacity: ticketTypes.capacity, issued: ticketTypes.issued })
      .from(ticketTypes)
      .where(and(eq(ticketTypes.eventId, eventId), eq(ticketTypes.idx, type.idx)));
    const remaining = now?.capacity == null ? null : Math.max(0, now.capacity - now.issued);
    throw conflict("sold_out", `ticket type "${type.name}" is sold out or has too few left`, {
      remaining,
    });
  }
}

async function loadByIds(db: Db | Tx, ids: string[]): Promise<TicketRow[]> {
  const rows = await db
    .select()
    .from(tickets)
    .where(
      inArray(
        tickets.id,
        ids.map((h) => toBuffer(hexToBytes(h))),
      ),
    );
  const byId = new Map(rows.map((r) => [idHex(r), r]));
  return ids.map((id) => byId.get(id)).filter((r): r is TicketRow => !!r);
}

async function replay(
  ctx: AppContext,
  event: EventRow,
  key: string,
  requestHash: string,
  render: boolean,
): Promise<IssueResult> {
  const [stored] = await ctx.db
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.eventId, event.id), eq(idempotencyKeys.key, key)));
  if (!stored) throw conflict("retry", "please retry");
  if (stored.requestHash !== requestHash) {
    throw new HttpError(
      422,
      "idempotency_conflict",
      "this idempotency key was used for a different request",
    );
  }
  const rows = await loadByIds(ctx.db, stored.ticketIds);
  return {
    created: false,
    tickets: await Promise.all(rows.map((row) => toIssued(ctx, event, row, render))),
  };
}

/**
 * Cancelling frees the ticket's place on its type (`issued` - 1) in the same transaction, only when
 * this call is the one that moves it to `cancelled`, so a repeat or concurrent cancel frees one.
 */
export async function cancelTicket(ctx: AppContext, idHexValue: string) {
  const row = await loadTicket(ctx.db, idHexValue);
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(tickets).where(eq(tickets.id, row.id)).for("update");
    if (!locked || locked.status === "cancelled") return;
    await tx
      .update(tickets)
      .set({
        status: "cancelled",
        cancelledAt: ctx.now(),
        updatedAt: Math.max(ctx.now(), locked.updatedAt),
      })
      .where(eq(tickets.id, row.id));
    await tx
      .update(ticketTypes)
      .set({ issued: sql`${ticketTypes.issued} - 1` })
      .where(and(eq(ticketTypes.eventId, row.eventId), eq(ticketTypes.idx, row.ticketType)));
  });
  const after = await loadTicket(ctx.db, idHexValue);
  return {
    ticket_id: idHexValue,
    status: after.status as "valid" | "used_up" | "cancelled",
    updated_at: after.updatedAt,
  };
}

/**
 * Cancels the old ticket and issues a new one with the same rules. Capacity is net zero: the old
 * ticket's slot is handed to the new one in the same transaction. Only unused tickets can move.
 */
export async function transferTicket(
  ctx: AppContext,
  idHexValue: string,
  input: z.infer<typeof api.transferTicketRequest>,
  issuer: Issuer,
) {
  const old = await loadTicket(ctx.db, idHexValue);
  const event = await loadEvent(ctx.db, old.eventId);
  const now = ctx.now();
  const fresh: typeof tickets.$inferInsert = {
    id: toBuffer(randomBytes(16)),
    eventId: old.eventId,
    ticketType: old.ticketType,
    holderName: input.holder_name,
    holderEmail: input.holder_email ?? null,
    note: old.note,
    issuedBy: issuer.id,
    tokenNonce: toBuffer(randomBytes(12)),
    entryMode: old.entryMode,
    maxAdmits: old.maxAdmits,
    gateMask: old.gateMask,
    slotStart: old.slotStart,
    slotEnd: old.slotEnd,
    issuedAt: now,
    updatedAt: now,
  };

  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(tickets).where(eq(tickets.id, old.id)).for("update");
    if (!locked) throw notFound("ticket not found");
    if (locked.status !== "valid" || locked.admitsUsed > 0 || locked.inside) {
      throw conflict(
        "not_transferable",
        `ticket is ${locked.status === "valid" ? "already used" : locked.status}`,
      );
    }
    await tx
      .update(tickets)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: Math.max(now, locked.updatedAt) })
      .where(eq(tickets.id, old.id));
    await tx
      .update(ticketTypes)
      .set({ issued: sql`${ticketTypes.issued} - 1` })
      .where(and(eq(ticketTypes.eventId, old.eventId), eq(ticketTypes.idx, old.ticketType)));
    const type = await loadType(tx, old.eventId, old.ticketType);
    await takeCapacity(tx, old.eventId, type, 1);
    await tx.insert(tickets).values(fresh);
    if (input.holder_email) {
      await tx.insert(emailQueue).values({
        ticketId: fresh.id as Uint8Array,
        toEmail: input.holder_email,
        nextAttemptAt: now,
        createdAt: now,
      });
    }
  });

  const [row] = await loadByIds(ctx.db, [bytesToHex(fresh.id as Uint8Array)]);
  return { cancelled_ticket_id: idHexValue, ticket: await toIssued(ctx, event, row!) };
}

/** Queues another email of the same QR (same id, same nonce, same token). */
export async function resendTicket(ctx: AppContext, idHexValue: string, email?: string) {
  const row = await loadTicket(ctx.db, idHexValue);
  if (row.status === "cancelled") throw conflict("cancelled", "ticket is cancelled");
  const event = await loadEvent(ctx.db, row.eventId);
  if (!(await ctx.signer.canMint(event.signKeyId))) {
    throw conflict(
      "signing_key_retired",
      "this ticket's signing key was retired after its event ended; the QR can no longer be re-sent",
    );
  }
  const to = email ?? row.holderEmail;
  if (!to) throw badRequest("the ticket has no email address; pass one in the request");
  const now = ctx.now();
  const [res] = await ctx.db.insert(emailQueue).values({
    ticketId: row.id,
    toEmail: to,
    nextAttemptAt: now,
    createdAt: now,
  });
  return { queued: true as const, email_queue_id: res.insertId };
}

export async function listTickets(
  ctx: AppContext,
  eventId: number,
  opts: { q?: string; limit: number; offset: number },
) {
  await loadEvent(ctx.db, eventId);
  const q = opts.q?.trim();
  const hex = (q ?? "").toUpperCase().replace(/[^0-9A-F]/g, "");
  const like = (q ?? "").replace(/[%_\\]/g, "\\$&");
  const search = q
    ? hex.length === q.length && hex.length >= 4
      ? sql`AND (${tickets.holderName} LIKE ${"%" + like + "%"} OR HEX(${tickets.id}) LIKE ${"%" + hex})`
      : sql`AND ${tickets.holderName} LIKE ${"%" + like + "%"}`
    : sql``;
  const rows = await ctx.db
    .select()
    .from(tickets)
    .where(sql`${tickets.eventId} = ${eventId} ${search}`)
    .orderBy(tickets.issuedAt, tickets.id)
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map((r) => ({
    ticket_id: idHex(r),
    short_id: shortTicketId({ ticketId: r.id }),
    holder_name: r.holderName,
    holder_email: r.holderEmail,
    ticket_type: r.ticketType,
    status: r.status,
    admits_used: r.admitsUsed,
    inside: r.inside,
    issued_at: r.issuedAt,
    updated_at: r.updatedAt,
  }));
}
