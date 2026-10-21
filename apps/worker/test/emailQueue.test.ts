import { eq } from "drizzle-orm";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToBytes, mysqlSchema, verifyToken } from "@events-qr/core";
import { createEvent } from "@events-qr/web/server/events";
import {
  issueTickets,
  cancelTicket,
  resendTicket,
  tokenForRow,
} from "@events-qr/web/server/tickets";
import { loadEvent } from "@events-qr/web/server/events";
import { backoffSeconds, drainEmailQueue, type DrainResult } from "../src/emailQueue";
import { SendError, type MailSender } from "../src/gmail";
import type { OutgoingEmail } from "../src/mime";
import {
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  type TestEnv,
  type TestStaff,
} from "../../web/test/helpers";

const { emailQueue, tickets } = mysqlSchema;

class MockSender implements MailSender {
  sent: OutgoingEmail[] = [];
  /** Return an error to fail that attempt, or nothing to succeed. */
  plan: (mail: OutgoingEmail, attempt: number) => Error | undefined = () => undefined;
  attempts = 0;
  async send(mail: OutgoingEmail): Promise<void> {
    const err = this.plan(mail, ++this.attempts);
    if (err) throw err;
    this.sent.push(mail);
  }
}

describe.skipIf(!dbAvailable)("email worker (MariaDB, mocked Gmail)", () => {
  let env: TestEnv;
  let staff: TestStaff;
  let eventId: number;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  const drain = (sender: MailSender): Promise<DrainResult> =>
    drainEmailQueue({ ctx: env.ctx, sender, from: "tickets@example.org", sleep });
  const queue = () => env.handle.db.select().from(emailQueue).orderBy(emailQueue.id);
  const issue = (name: string, email: string | undefined, over: Record<string, unknown> = {}) =>
    issueTickets(
      env.ctx,
      eventId,
      {
        idempotency_key: newKey(),
        ticket_type: 2,
        quantity: 1,
        holder_name: name,
        holder_email: email,
        ...over,
      } as never,
      staff,
    );

  beforeAll(async () => {
    env = await createTestEnv();
    staff = await makeStaff(env, "staff");
    eventId = (await createEvent(env.ctx, eventBody(env.clock.now + 86400) as never)).id;
  });
  afterAll(() => env.close());

  async function reset() {
    await env.handle.db.delete(emailQueue);
    sleeps.length = 0;
  }

  it("sends holder name, event, ticket type, last 6 hex and the QR as an inline PNG", async () => {
    await reset();
    const [t] = (await issue("Jane <Doe>", "jane@example.org")).tickets;
    const sender = new MockSender();
    expect(await drain(sender)).toEqual({ sent: 1, failed: 0, retried: 0, throttled: false });

    const mail = sender.sent[0]!;
    expect(mail).toMatchObject({
      from: "tickets@example.org",
      to: "jane@example.org",
      subject: "Your ticket for Summer Fest",
    });
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain("Summer Fest");
      expect(part).toContain("Staff");
      expect(part).toContain(t!.short_id);
    }
    expect(mail.text).toContain("Jane <Doe>");
    expect(mail.html).toContain("Jane &lt;Doe&gt;"); // escaped
    expect(mail.html).toContain('src="cid:ticket-qr"');

    const png = PNG.sync.read(Buffer.from(mail.inline[0]!.data));
    expect(mail.inline[0]).toMatchObject({ cid: "ticket-qr", contentType: "image/png" });
    expect(png.width).toBeGreaterThanOrEqual(300);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(t!.token); // the emailed QR is the very token that was generated
    const verified = await verifyToken(
      decoded!.data,
      env.signer.publicKeys(),
      await env.eventKeyFor(eventId),
      eventId,
    );
    expect(verified.ok).toBe(true);

    const [row] = await queue();
    expect(row).toMatchObject({ status: "sent", attempts: 0, lastError: null });
    expect(row!.sentAt).toBe(env.clock.now);
  });

  it("a re-sent email carries the byte-identical token", async () => {
    await reset();
    const [t] = (await issue("Resend Me", "resend@example.org")).tickets;
    const sender = new MockSender();
    await drain(sender);
    await resendTicket(env.ctx, t!.ticket_id);
    await drain(sender);
    const decode = (m: OutgoingEmail) => {
      const png = PNG.sync.read(Buffer.from(m.inline[0]!.data));
      return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)!.data;
    };
    expect(sender.sent.map(decode)).toEqual([t!.token, t!.token]);
    const event = await loadEvent(env.handle.db, eventId);
    const [row] = await env.handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, Buffer.from(hexToBytes(t!.ticket_id))));
    expect(await tokenForRow(env.ctx, event, row!)).toBe(t!.token);
  });

  describe("throttling", () => {
    it("never sends more than the daily limit in a rolling 24 hours", async () => {
      await reset();
      env.ctx.config.EMAIL_DAILY_LIMIT = 3;
      try {
        for (let i = 0; i < 5; i++) await issue(`Bulk ${i}`, `bulk${i}@example.org`);
        const sender = new MockSender();
        expect((await drain(sender)).sent).toBe(3);
        expect((await drain(sender)).throttled).toBe(true);
        expect(sender.sent).toHaveLength(3);
        expect((await queue()).filter((r) => r.status === "pending")).toHaveLength(2);

        env.clock.now += 23 * 3600;
        expect((await drain(sender)).sent).toBe(0); // the first three are still inside the window
        env.clock.now += 3600 + 1;
        expect((await drain(sender)).sent).toBe(2);
        expect(sender.sent.map((m) => m.to)).toEqual(
          ["bulk0", "bulk1", "bulk2", "bulk3", "bulk4"].map((n) => `${n}@example.org`),
        );
      } finally {
        env.ctx.config.EMAIL_DAILY_LIMIT = 1800;
      }
    });

    it("spaces consecutive sends by the configured interval", async () => {
      await reset();
      env.ctx.config.EMAIL_MIN_INTERVAL_MS = 250;
      try {
        for (let i = 0; i < 3; i++) await issue(`Paced ${i}`, `paced${i}@example.org`);
        await drain(new MockSender());
        expect(sleeps).toEqual([250, 250]); // between sends, not before the first
      } finally {
        env.ctx.config.EMAIL_MIN_INTERVAL_MS = 0;
      }
    });
  });

  describe("retry", () => {
    it("backs off exponentially and records the error until it succeeds", async () => {
      await reset();
      await issue("Flaky", "flaky@example.org");
      const sender = new MockSender();
      sender.plan = (_m, attempt) =>
        attempt <= 2
          ? new SendError(`Gmail send failed (503) attempt ${attempt}`, false)
          : undefined;

      expect(await drain(sender)).toMatchObject({ sent: 0, retried: 1 });
      let [row] = await queue();
      expect(row).toMatchObject({
        status: "pending",
        attempts: 1,
        nextAttemptAt: env.clock.now + 30,
      });
      expect(row!.lastError).toContain("503");

      expect(await drain(sender)).toMatchObject({ sent: 0, retried: 0 }); // not due yet
      expect(sender.attempts).toBe(1);

      env.clock.now += 30;
      await drain(sender);
      [row] = await queue();
      expect(row).toMatchObject({
        status: "pending",
        attempts: 2,
        nextAttemptAt: env.clock.now + 60,
      });

      env.clock.now += 60;
      expect(await drain(sender)).toMatchObject({ sent: 1 });
      [row] = await queue();
      expect(row).toMatchObject({ status: "sent", attempts: 2, lastError: null });
      expect([1, 2, 3, 4, 5, 6, 7].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480, 960, 1920]);
      expect(backoffSeconds(20)).toBe(3600);
    });

    it("gives up after the maximum number of attempts and keeps the last error", async () => {
      await reset();
      env.ctx.config.EMAIL_MAX_ATTEMPTS = 3;
      try {
        await issue("Hopeless", "hopeless@example.org");
        const sender = new MockSender();
        sender.plan = () => new Error("connection reset");
        for (let i = 0; i < 3; i++) {
          await drain(sender);
          env.clock.now += 4000;
        }
        const [row] = await queue();
        expect(row).toMatchObject({ status: "failed", attempts: 3, lastError: "connection reset" });
        await drain(sender);
        expect(sender.attempts).toBe(3); // failed rows are left alone
      } finally {
        env.ctx.config.EMAIL_MAX_ATTEMPTS = 6;
      }
    });

    it("does not retry a permanent error", async () => {
      await reset();
      await issue("Bad address", "nope@example.org");
      const sender = new MockSender();
      sender.plan = () => new SendError("Gmail send failed (400): Invalid To header", true);
      expect(await drain(sender)).toMatchObject({ failed: 1, retried: 0 });
      const [row] = await queue();
      expect(row).toMatchObject({ status: "failed", attempts: 1 });
      expect(row!.lastError).toContain("Invalid To header");
    });
  });

  it("does not email a cancelled ticket", async () => {
    await reset();
    const [t] = (await issue("Refunded", "refund@example.org")).tickets;
    await cancelTicket(env.ctx, t!.ticket_id);
    const sender = new MockSender();
    expect(await drain(sender)).toMatchObject({ sent: 0, failed: 1 });
    expect(sender.sent).toEqual([]);
    expect((await queue())[0]).toMatchObject({
      status: "failed",
      lastError: "ticket is cancelled or gone",
    });
  });

  it("two workers draining at once send each email once", async () => {
    await reset();
    for (let i = 0; i < 6; i++) await issue(`Dup ${i}`, `dup${i}@example.org`);
    const a = new MockSender();
    const b = new MockSender();
    await Promise.all([drain(a), drain(b)]);
    expect([...a.sent, ...b.sent].map((m) => m.to).sort()).toEqual(
      Array.from({ length: 6 }, (_, i) => `dup${i}@example.org`),
    );
  });

  it("recovers an email left 'sending' by a crashed worker", async () => {
    await reset();
    await issue("Crashed", "crash@example.org");
    await env.handle.db
      .update(emailQueue)
      .set({ status: "sending", nextAttemptAt: env.clock.now + 300 });
    const sender = new MockSender();
    expect((await drain(sender)).sent).toBe(0); // lease still held
    env.clock.now += 301;
    expect((await drain(sender)).sent).toBe(1);
  });

  it("ignores tickets without an email address", async () => {
    await reset();
    await issue("Paper only", undefined);
    expect(await queue()).toEqual([]);
  });
});
