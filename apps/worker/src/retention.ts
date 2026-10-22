import { and, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "@events-qr/web/server/context";

const { events, tickets, scans, emailQueue } = mysqlSchema;

const DAY = 86400;
const CHUNK = 1000;

export interface RetentionResult {
  dryRun: boolean;
  /** Tickets whose holder name or email was (or would be) cleared. */
  ticketsCleared: number;
  /** Queued email rows (they hold addresses) deleted. */
  emailsDeleted: number;
  scansDeleted: number;
}

export interface RetentionOptions {
  piiDays?: number;
  scanDays?: number;
  dryRun?: boolean;
  log?: (line: string) => void;
}

/**
 * Data retention (docs/spec.md "Security"): `holder_name` and `holder_email` become NULL
 * `RETENTION_PII_DAYS` after an event's `ends_at` (queued emails for those tickets go too), and
 * scans are deleted `RETENTION_SCANS_DAYS` after it. Ticket ids, types, admit counts and status
 * stay. Idempotent: each pass only touches what is still there. A dry run counts without changing.
 */
export async function runRetention(
  ctx: AppContext,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const piiDays = options.piiDays ?? ctx.config.RETENTION_PII_DAYS;
  const scanDays = options.scanDays ?? ctx.config.RETENTION_SCANS_DAYS;
  const dryRun = options.dryRun ?? ctx.config.RETENTION_DRY_RUN;
  const log = options.log ?? ((line: string) => console.log(line));
  const now = ctx.now();
  const result: RetentionResult = { dryRun, ticketsCleared: 0, emailsDeleted: 0, scansDeleted: 0 };

  const dueEvents = async (days: number): Promise<number[]> =>
    (
      await ctx.db
        .select({ id: events.id })
        .from(events)
        .where(lte(events.endsAt, now - days * DAY))
    ).map((e) => e.id);

  const piiEvents = await dueEvents(piiDays);
  if (piiEvents.length) {
    const hasPii = and(
      inArray(tickets.eventId, piiEvents),
      or(isNotNull(tickets.holderName), isNotNull(tickets.holderEmail)),
    );
    const [{ n = 0 } = {}] = await ctx.db
      .select({ n: sql<number>`COUNT(*)` })
      .from(tickets)
      .where(hasPii);
    result.ticketsCleared = Number(n);

    const [{ q = 0 } = {}] = await ctx.db
      .select({ q: sql<number>`COUNT(*)` })
      .from(emailQueue)
      .innerJoin(tickets, sql`${tickets.id} = ${emailQueue.ticketId}`)
      .where(inArray(tickets.eventId, piiEvents));
    result.emailsDeleted = Number(q);

    if (!dryRun) {
      await ctx.db
        .delete(emailQueue)
        .where(
          inArray(
            emailQueue.ticketId,
            ctx.db
              .select({ id: tickets.id })
              .from(tickets)
              .where(inArray(tickets.eventId, piiEvents)),
          ),
        );
      await ctx.db.update(tickets).set({ holderName: null, holderEmail: null }).where(hasPii);
    }
  }

  const scanEvents = await dueEvents(scanDays);
  if (scanEvents.length) {
    for (;;) {
      const ids = (
        await ctx.db
          .select({ id: scans.id })
          .from(scans)
          .innerJoin(tickets, sql`${tickets.id} = ${scans.ticketId}`)
          .where(inArray(tickets.eventId, scanEvents))
          .limit(CHUNK)
      ).map((r) => r.id);
      if (ids.length === 0) break;
      if (dryRun) {
        // A dry run cannot page by deleting; count in one go instead.
        const [{ n = 0 } = {}] = await ctx.db
          .select({ n: sql<number>`COUNT(*)` })
          .from(scans)
          .innerJoin(tickets, sql`${tickets.id} = ${scans.ticketId}`)
          .where(inArray(tickets.eventId, scanEvents));
        result.scansDeleted = Number(n);
        break;
      }
      await ctx.db.delete(scans).where(inArray(scans.id, ids));
      result.scansDeleted += ids.length;
    }
  }

  log(
    `worker: retention${dryRun ? " (dry run, nothing changed)" : ""}: ${result.ticketsCleared} tickets cleared of name/email, ` +
      `${result.emailsDeleted} queued emails deleted, ${result.scansDeleted} scans deleted`,
  );
  return result;
}

export const RETENTION_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** True once per UTC day, after `hourUtc`. `lastRunDay` is the `YYYY-MM-DD` of the previous run. */
export function retentionDue(nowSeconds: number, hourUtc: number, lastRunDay: string | undefined) {
  const d = new Date(nowSeconds * 1000);
  const day = d.toISOString().slice(0, 10);
  return day !== lastRunDay && d.getUTCHours() >= hourUtc ? day : undefined;
}
