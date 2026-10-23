/**
 * Makes the "Dress rehearsal" event of docs/field-test.md on a dev or staging VM: two gates, five
 * ticket types, the 50 test tickets (with one cancelled and one transferred) and a printable
 * HTML sheet with one QR per ticket.
 *
 *   bun scripts/rehearsal-seed.ts --yes --out rehearsal-sheet.html [--target-url https://staging.example.org]
 *
 * - Refuses to run without `--yes`.
 * - Refuses to run when the target is the production server: the target is `--target-url`, or else
 *   `PUBLIC_URL`; production is `PRODUCTION_URL`. With `NODE_ENV=production` it also refuses unless
 *   `PRODUCTION_URL` is set and differs from the target.
 * - Needs an existing admin (`bun scripts/create-admin.ts`); the tickets are issued as that admin.
 * - Idempotent: running it again re-uses the event and its tickets (each ticket has a fixed
 *   idempotency key) and rewrites the sheet with the same QR codes.
 */
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { mysqlSchema } from "../packages/core/src";
import { loadConfig } from "../apps/web/src/server/config";
import { buildContext, type AppContext } from "../apps/web/src/server/context";
import { createEvent, eventDayZero, loadEvent } from "../apps/web/src/server/events";
import {
  cancelTicket,
  issueTickets,
  toIssued,
  transferTicket,
  type Issuer,
  type TicketRow,
} from "../apps/web/src/server/tickets";

const { events, tickets, staff } = mysqlSchema;

export const EVENT_NAME = "Dress rehearsal";
export const GATES = ["Gate A", "Gate B"];
const NOTE_PREFIX = "rehearsal:";
const SLOT_OPEN_END = 0xffff;

/** The five ticket types the field test needs. `gate_mask` bit 0 is Gate A, bit 1 is Gate B. */
export const TICKET_TYPES = [
  { idx: 0, name: "General", entry_rule: { mode: "single" as const } },
  {
    idx: 1,
    name: "Re-entry (3)",
    entry_rule: { mode: "limited" as const, max_admits: 3 },
  },
  { idx: 2, name: "VIP", entry_rule: { mode: "unlimited" as const } },
  { idx: 3, name: "Gate B only", entry_rule: { mode: "single" as const }, gate_mask: 0b10 },
  { idx: 4, name: "Timed", entry_rule: { mode: "single" as const } },
];

type Scenario =
  | "single"
  | "cancelled"
  | "transfer"
  | "reentry-3"
  | "unlimited"
  | "gate-b-only"
  | "slot-open"
  | "slot-early"
  | "slot-ended";

/** (scenario, ticket type, how many): 21 + 1 + 2 (a transfer is two tickets) + 8 + 6 + 6 + 6 = 50. */
const MIX: { scenario: Scenario; type: number; count: number }[] = [
  { scenario: "single", type: 0, count: 21 },
  { scenario: "cancelled", type: 0, count: 1 },
  { scenario: "transfer", type: 0, count: 1 },
  { scenario: "reentry-3", type: 1, count: 8 },
  { scenario: "unlimited", type: 2, count: 6 },
  { scenario: "gate-b-only", type: 3, count: 6 },
  { scenario: "slot-open", type: 4, count: 3 },
  { scenario: "slot-early", type: 4, count: 2 },
  { scenario: "slot-ended", type: 4, count: 1 },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Whether the script may run against this target. Returns the reason to refuse, or undefined. */
export function refusal(opts: {
  yes: boolean;
  env: Record<string, string | undefined>;
  targetUrl?: string;
}): string | undefined {
  if (!opts.yes) return "pass --yes to confirm that this is a dev or staging server";
  const origin = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      return new URL(u).origin;
    } catch {
      return u.replace(/\/+$/, "");
    }
  };
  const production = origin(opts.env.PRODUCTION_URL);
  const target = origin(opts.targetUrl ?? opts.env.PUBLIC_URL);
  if (production && target && production === target)
    return `the target ${target} is the production server (PRODUCTION_URL)`;
  if (opts.env.NODE_ENV === "production" && (!production || !target))
    return "NODE_ENV is production: set PRODUCTION_URL and the target (--target-url or PUBLIC_URL) so the script can tell them apart";
  return undefined;
}

async function findAdmin(ctx: AppContext): Promise<Issuer> {
  // drizzle-orm is not resolvable from scripts/ (it lives in the workspaces), so the lookups below
  // select whole tables and filter here: a dev or staging database is small.
  const admins = (
    await ctx.db.select({ id: staff.id, name: staff.name, role: staff.role }).from(staff)
  )
    .filter((s) => s.role === "admin")
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!admins[0])
    throw new Error('no admin yet: run `bun scripts/create-admin.ts --name "Name"` first');
  return { id: admins[0].id, role: "admin" };
}

async function ensureEvent(ctx: AppContext): Promise<number> {
  const existing = (await ctx.db.select({ id: events.id, name: events.name }).from(events))
    .filter((e) => e.name === EVENT_NAME)
    .sort((a, b) => a.id - b.id)[0];
  if (existing) return existing.id;
  const now = ctx.now();
  const { id } = await createEvent(ctx, {
    name: EVENT_NAME,
    venue: "Rehearsal venue",
    // Doors opened three hours ago, so the "slot ended" tickets have already ended.
    starts_at: now - 3 * 3600,
    ends_at: now - 3 * 3600 + 7 * 86400,
    gates: GATES,
    ticket_types: TICKET_TYPES,
  });
  return id;
}

async function eventNotes(ctx: AppContext, eventId: number) {
  return (await ctx.db.select().from(tickets)).filter(
    (r) => r.eventId === eventId && r.note?.startsWith(NOTE_PREFIX),
  );
}

/** Creates or reuses the event and its 50 tickets. Safe to run again. */
export async function seedRehearsal(ctx: AppContext, issuer?: Issuer): Promise<number> {
  const who = issuer ?? (await findAdmin(ctx));
  const eventId = await ensureEvent(ctx);
  const event = await loadEvent(ctx.db, eventId);
  // Slots are fixed offsets from the doors-open time (not from "now"), so a re-run sends the same
  // request and the idempotency keys replay: open from the doors, ended two hours after them (the
  // event is created three hours after its doors-open time), too early until five days after them.
  const doorsMinute = Math.round((event.startsAt - eventDayZero(ctx, event)) / 60);
  const slots: Partial<Record<Scenario, { start: number; end: number }>> = {
    "slot-open": { start: doorsMinute, end: SLOT_OPEN_END },
    "slot-early": { start: doorsMinute + 5 * 1440, end: SLOT_OPEN_END },
    "slot-ended": { start: doorsMinute, end: doorsMinute + 120 },
  };

  let n = 0;
  for (const { scenario, type, count } of MIX) {
    for (let i = 0; i < count; i++) {
      n++;
      const note = `${NOTE_PREFIX}${pad(n)}:${scenario}`;
      const { tickets: made } = await issueTickets(
        ctx,
        eventId,
        {
          idempotency_key: `rehearsal-${eventId}-${pad(n)}`,
          ticket_type: type,
          quantity: 1,
          holder_name: `Test ${pad(n)} ${scenario}`,
          note,
          ...(slots[scenario] ? { slot: slots[scenario] } : {}),
        },
        who,
        { render: false },
      );
      const ticketId = made[0]!.ticket_id;
      if (scenario === "cancelled") await cancelTicket(ctx, ticketId);
      if (scenario === "transfer") {
        const both = (await eventNotes(ctx, eventId)).filter((r) => r.note === note);
        if (both.length === 1) {
          // Not transferred yet. The new holder's ticket is the one the sheet shows as `transfer-new`.
          await transferTicket(ctx, ticketId, { holder_name: `Test ${pad(n)} new holder` }, who);
        }
      }
    }
  }
  return eventId;
}

export interface SheetEntry {
  holder: string | null;
  type: string;
  scenario: string;
  shortId: string;
  png: string;
}

/** The scenario printed on the sheet: the note's last part, `transfer` split by whether it was cancelled. */
export function scenarioOf(row: Pick<TicketRow, "note" | "status">): string {
  const scenario = (row.note ?? "").split(":")[2] ?? "unknown";
  if (scenario !== "transfer") return scenario;
  return row.status === "cancelled" ? "transfer-old" : "transfer-new";
}

export async function sheetEntries(ctx: AppContext, eventId: number): Promise<SheetEntry[]> {
  const event = await loadEvent(ctx.db, eventId);
  const rows = (await eventNotes(ctx, eventId)).sort(
    (a, b) =>
      a.note!.localeCompare(b.note!) || a.issuedAt - b.issuedAt || a.status.localeCompare(b.status),
  );
  const typeNames = new Map(TICKET_TYPES.map((t) => [t.idx, t.name]));
  return Promise.all(
    rows.map(async (row) => {
      const issued = await toIssued(ctx, event, row);
      return {
        holder: row.holderName,
        type: typeNames.get(row.ticketType) ?? `Type ${row.ticketType}`,
        scenario: scenarioOf(row),
        shortId: issued.short_id,
        png: issued.qr_png,
      };
    }),
  );
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function renderSheet(entries: SheetEntry[]): string {
  const figures = entries
    .map(
      (e) => `    <figure>
      <img src="${e.png}" alt="QR for ${esc(e.holder ?? e.shortId)}">
      <figcaption>
        <strong>${esc(e.holder ?? "")}</strong><br>
        ${esc(e.type)}<br>
        <em>${esc(e.scenario)}</em><br>
        <code>${esc(e.shortId)}</code>
      </figcaption>
    </figure>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${EVENT_NAME}: test tickets</title>
  <style>
    body { font: 12px/1.3 system-ui, sans-serif; margin: 12mm; }
    h1 { font-size: 16px; }
    .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8mm; }
    figure { margin: 0; text-align: center; break-inside: avoid; }
    img { width: 52mm; height: 52mm; }
    figcaption code { font-size: 14px; }
    @media print { h1 { display: none; } }
  </style>
</head>
<body>
  <h1>${EVENT_NAME}: ${entries.length} test tickets</h1>
  <div class="sheet" data-testid="rehearsal-sheet">
${figures}
  </div>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      yes: { type: "boolean", default: false },
      out: { type: "string" },
      "target-url": { type: "string" },
    },
  });
  const why = refusal({
    yes: values.yes ?? false,
    env: process.env,
    targetUrl: values["target-url"],
  });
  if (why) {
    console.error(`refusing to run: ${why}`);
    process.exit(1);
  }
  if (!values.out) {
    console.error(
      "usage: bun scripts/rehearsal-seed.ts --yes --out <sheet.html> [--target-url <url>]",
    );
    process.exit(1);
  }
  const ctx = await buildContext(loadConfig());
  const eventId = await seedRehearsal(ctx);
  const entries = await sheetEntries(ctx, eventId);
  writeFileSync(values.out, renderSheet(entries));
  console.log(
    `"${EVENT_NAME}" is event ${eventId}: ${entries.length} tickets, sheet written to ${values.out}`,
  );
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
