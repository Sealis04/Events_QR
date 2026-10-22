import { z } from "zod";
import { api } from "@events-qr/core";
import type { AppContext } from "./context";
import { HttpError } from "./http";
import { loadEvent } from "./events";
import { issueTickets, type Issuer } from "./tickets";
import { mysqlSchema } from "@events-qr/core";
import { asc, eq } from "drizzle-orm";
import { randomToken } from "./secrets";

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF, commas only. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // drop a BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  return rows;
}

export const MAX_IMPORT_ROWS = 5000;

/**
 * CSV columns (header row required): `holder_name`, `ticket_type` (index or name), and optional
 * `holder_email`, `note`. Every row goes through the same capacity transaction as the generator;
 * a failing row is reported and the rest carry on. Rows have their own idempotency key, derived
 * from the request's key, so repeating an import does not issue anything twice.
 */
export async function importTickets(
  ctx: AppContext,
  eventId: number,
  input: z.infer<typeof api.importTicketsRequest>,
  issuer: Issuer,
): Promise<z.infer<typeof api.importTicketsResponse>> {
  await loadEvent(ctx.db, eventId);
  const types = await ctx.db
    .select()
    .from(mysqlSchema.ticketTypes)
    .where(eq(mysqlSchema.ticketTypes.eventId, eventId))
    .orderBy(asc(mysqlSchema.ticketTypes.idx));

  const [header, ...body] = parseCsv(input.csv);
  if (!header) throw new HttpError(400, "invalid_request", "the CSV is empty");
  const cols = header.map((h) => h.trim().toLowerCase());
  const col = (name: string) => cols.indexOf(name);
  for (const required of ["holder_name", "ticket_type"]) {
    if (col(required) < 0)
      throw new HttpError(400, "invalid_request", `missing column ${required}`);
  }
  if (body.length > MAX_IMPORT_ROWS) {
    throw new HttpError(400, "invalid_request", `at most ${MAX_IMPORT_ROWS} rows per import`);
  }

  const key = input.idempotency_key ?? randomToken(12);
  const errors: { row: number; message: string }[] = [];
  let created = 0;

  for (const [i, cells] of body.entries()) {
    const rowNumber = i + 2; // spreadsheet-style, header is row 1
    const get = (name: string) => cells[col(name)]?.trim() ?? "";
    try {
      const typeText = get("ticket_type");
      const type =
        types.find((t) => /^\d+$/.test(typeText) && t.idx === Number(typeText)) ??
        types.find((t) => t.name.toLowerCase() === typeText.toLowerCase());
      if (!type) throw new Error(`unknown ticket type "${typeText}"`);
      const parsed = api.createTicketsRequest.safeParse({
        idempotency_key: `${key}:${rowNumber}`.padEnd(8, "_"),
        ticket_type: type.idx,
        quantity: 1,
        holder_name: get("holder_name") || undefined,
        holder_email: get("holder_email") || undefined,
        note: get("note") || undefined,
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; "),
        );
      await issueTickets(ctx, eventId, parsed.data, issuer, { render: false });
      created += 1;
    } catch (err) {
      errors.push({ row: rowNumber, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { created, errors };
}

const csvCell = (v: string | number | null): string => {
  const s = v === null ? "" : String(v);
  // A leading = + - @ would be run as a formula by a spreadsheet; prefix it so it stays text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** `GET /api/events/{id}/tickets/export`: one row per ticket, in the columns the import reads plus status and use. */
export async function exportTicketsCsv(ctx: AppContext, eventId: number): Promise<string> {
  await loadEvent(ctx.db, eventId);
  const types = await ctx.db
    .select()
    .from(mysqlSchema.ticketTypes)
    .where(eq(mysqlSchema.ticketTypes.eventId, eventId));
  const typeName = new Map(types.map((t) => [t.idx, t.name]));
  const rows = await ctx.db
    .select()
    .from(mysqlSchema.tickets)
    .where(eq(mysqlSchema.tickets.eventId, eventId))
    .orderBy(asc(mysqlSchema.tickets.issuedAt), asc(mysqlSchema.tickets.id));
  const lines = [
    ["ticket_id", "short_id", "holder_name", "holder_email", "ticket_type", "status", "admits_used", "inside", "note"].join(","),
  ];
  for (const r of rows) {
    const id = Buffer.from(r.id).toString("hex");
    lines.push(
      [
        id,
        id.slice(-6).toUpperCase(),
        r.holderName,
        r.holderEmail,
        typeName.get(r.ticketType) ?? r.ticketType,
        r.status,
        r.admitsUsed,
        r.inside ? "yes" : "no",
        r.note,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
