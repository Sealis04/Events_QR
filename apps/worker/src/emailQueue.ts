import { and, asc, eq, lte, sql } from "drizzle-orm";
import { mysqlSchema, shortTicketId } from "@events-qr/core";
import type { AppContext } from "@events-qr/web/server/context";
import { affectedRows } from "@events-qr/web/server/dbutil";
import { SigningKeyUnavailable } from "@events-qr/web/server/signing";
import { eventConfig, loadEvent, loadType } from "@events-qr/web/server/events";
import { renderQr } from "@events-qr/web/server/qr";
import { tokenForRow } from "@events-qr/web/server/tickets";
import { SendError, type MailSender } from "./gmail";
import type { OutgoingEmail } from "./mime";

const { emailQueue, tickets } = mysqlSchema;

/** A claimed row that never finishes (worker crashed) goes back to pending after this long. */
const LEASE_SECONDS = 300;
const BATCH = 50;
const DAY = 86_400;

export const backoffSeconds = (attempts: number): number =>
  Math.min(30 * 2 ** (attempts - 1), 3600);

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

export interface DrainDeps {
  ctx: AppContext;
  sender: MailSender;
  /** The mailbox address used in From. */
  from: string;
  sleep?: (ms: number) => Promise<void>;
}

export interface DrainResult {
  sent: number;
  failed: number;
  retried: number;
  /** True when the daily budget stopped the run. */
  throttled: boolean;
}

/**
 * One pass over the queue: claim due rows, send, record the outcome. Stays under the daily
 * limit (rolling 24 h of `sent_at`), spaces sends by EMAIL_MIN_INTERVAL_MS, retries with
 * exponential backoff and marks a row `failed` after EMAIL_MAX_ATTEMPTS or a permanent error.
 */
export async function drainEmailQueue(deps: DrainDeps): Promise<DrainResult> {
  const { ctx, sender } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: DrainResult = { sent: 0, failed: 0, retried: 0, throttled: false };
  const now = ctx.now();

  await ctx.db
    .update(emailQueue)
    .set({ status: "pending" })
    .where(and(eq(emailQueue.status, "sending"), lte(emailQueue.nextAttemptAt, now)));

  const [{ used = 0 } = {}] = await ctx.db
    .select({ used: sql<number>`COUNT(*)` })
    .from(emailQueue)
    .where(
      sql`(${emailQueue.status} = 'sent' AND ${emailQueue.sentAt} > ${now - DAY}) OR ${emailQueue.status} = 'sending'`,
    );
  const budget = ctx.config.EMAIL_DAILY_LIMIT - Number(used);
  if (budget <= 0) return { ...result, throttled: true };

  const due = await ctx.db
    .select()
    .from(emailQueue)
    .where(and(eq(emailQueue.status, "pending"), lte(emailQueue.nextAttemptAt, now)))
    .orderBy(asc(emailQueue.nextAttemptAt), asc(emailQueue.id))
    .limit(Math.min(budget, BATCH));
  if (due.length === budget && budget < BATCH) result.throttled = true;

  let first = true;
  for (const item of due) {
    // Claim it; another worker (or a re-run) may have taken it.
    const [claim] = await ctx.db
      .update(emailQueue)
      .set({ status: "sending", nextAttemptAt: ctx.now() + LEASE_SECONDS })
      .where(and(eq(emailQueue.id, item.id), eq(emailQueue.status, "pending")));
    if (affectedRows(claim) !== 1) continue;

    if (!first) await sleep(ctx.config.EMAIL_MIN_INTERVAL_MS);
    first = false;

    try {
      const mail = await composeTicketEmail(deps, item.ticketId, item.toEmail);
      if (!mail) {
        await ctx.db
          .update(emailQueue)
          .set({ status: "failed", lastError: "ticket is cancelled or gone" })
          .where(eq(emailQueue.id, item.id));
        result.failed += 1;
        continue;
      }
      await sender.send(mail);
      await ctx.db
        .update(emailQueue)
        .set({ status: "sent", sentAt: ctx.now(), lastError: null })
        .where(eq(emailQueue.id, item.id));
      result.sent += 1;
    } catch (err) {
      const attempts = item.attempts + 1;
      const permanent =
        (err instanceof SendError && err.permanent) || err instanceof SigningKeyUnavailable;
      const giveUp = permanent || attempts >= ctx.config.EMAIL_MAX_ATTEMPTS;
      await ctx.db
        .update(emailQueue)
        .set({
          status: giveUp ? "failed" : "pending",
          attempts,
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
          nextAttemptAt: ctx.now() + backoffSeconds(attempts),
        })
        .where(eq(emailQueue.id, item.id));
      if (giveUp) result.failed += 1;
      else result.retried += 1;
    }
  }
  return result;
}

/** Holder name, event, ticket type, last 6 hex of the ticket id, and the QR as an inline PNG. */
async function composeTicketEmail(
  deps: DrainDeps,
  ticketId: Uint8Array,
  to: string,
): Promise<OutgoingEmail | undefined> {
  const { ctx } = deps;
  const [row] = await ctx.db
    .select()
    .from(tickets)
    .where(eq(tickets.id, Buffer.from(ticketId)))
    .limit(1);
  if (!row || row.status === "cancelled") return undefined;
  const event = await loadEvent(ctx.db, row.eventId);
  const type = await loadType(ctx.db, row.eventId, row.ticketType);
  const qr = await renderQr(await tokenForRow(ctx, event, row));
  const short = shortTicketId({ ticketId: row.id });
  const holder = row.holderName ?? "Guest";
  const venue = eventConfig(event).venue;
  const when = new Date(event.startsAt * 1000).toUTCString();

  const text = [
    `Hello ${holder},`,
    "",
    `Your ${type.name} ticket for ${event.name}${venue ? ` at ${venue}` : ""} is attached as a QR code.`,
    `Starts: ${when}`,
    `Ticket reference: ${short}`,
    "",
    "Show the QR code at the entrance, on your phone or printed. Keep it private: it works once.",
  ].join("\n");
  const html =
    `<p>Hello ${escapeHtml(holder)},</p>` +
    `<p>Your <b>${escapeHtml(type.name)}</b> ticket for <b>${escapeHtml(event.name)}</b>` +
    `${venue ? ` at ${escapeHtml(venue)}` : ""} is below.</p>` +
    `<p><img src="cid:ticket-qr" alt="Ticket QR code" width="300" height="300"></p>` +
    `<p>Ticket reference: <code>${escapeHtml(short)}</code><br>Starts: ${escapeHtml(when)}</p>` +
    `<p>Show the QR code at the entrance, on your phone or printed. Keep it private: it works once.</p>`;

  return {
    from: deps.from,
    to,
    subject: `Your ticket for ${event.name}`,
    text,
    html,
    inline: [
      {
        cid: "ticket-qr",
        contentType: "image/png",
        filename: `ticket-${short}.png`,
        data: qr.pngBytes,
      },
    ],
  };
}
