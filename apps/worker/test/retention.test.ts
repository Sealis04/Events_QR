import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, mysqlSchema } from "@events-qr/core";
import { createEvent } from "@events-qr/web/server/events";
import { issueTickets } from "@events-qr/web/server/tickets";
import { retentionDue, runRetention } from "../src/retention";
import {
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  type TestEnv,
} from "../../web/test/helpers";

const { events, tickets, scans, emailQueue } = mysqlSchema;
const DAY = 86400;

describe.skipIf(!dbAvailable)("retention job (MariaDB)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(() => env.close());

  /** An event whose `ends_at` is `endedDaysAgo` days before the test clock, with one named ticket and a scan. */
  async function seed(endedDaysAgo: number) {
    const admin = await makeStaff(env, "admin");
    const { id } = await createEvent(
      env.ctx,
      api.createEventRequest.parse(eventBody(env.clock.now + 3600)),
    );
    const t = (
      await issueTickets(
        env.ctx,
        id,
        api.createTicketsRequest.parse({
          idempotency_key: newKey(),
          ticket_type: 0,
          holder_name: "Pat Person",
          holder_email: "pat@example.org",
        }),
        { id: admin.id, role: "admin" },
        { render: false },
      )
    ).tickets[0]!;
    const ticketId = Buffer.from(t.ticket_id, "hex");
    await env.handle.db.insert(scans).values({
      id: randomUUID(),
      ticketId,
      gate: "Gate A",
      direction: "entry",
      scannedAt: env.clock.now,
      result: "admitted",
      offline: false,
    });
    await env.handle.db
      .update(tickets)
      .set({ admitsUsed: 1, inside: true })
      .where(eq(tickets.id, ticketId));
    await env.handle.db
      .update(events)
      .set({ endsAt: env.clock.now - endedDaysAgo * DAY })
      .where(eq(events.id, id));
    return { id, ticketId };
  }
  const ticketRow = async (id: Buffer) =>
    (await env.handle.db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const scanCount = async (id: Buffer) =>
    (await env.handle.db.select().from(scans).where(eq(scans.ticketId, id))).length;
  const mailCount = async (id: Buffer) =>
    (await env.handle.db.select().from(emailQueue).where(eq(emailQueue.ticketId, id))).length;
  const quiet = { log: () => {} };

  it("clears names and emails exactly at 1 year after the event, not a day earlier; keeps ids, types and counts", async () => {
    const early = await seed(364);
    const due = await seed(365);
    const result = await runRetention(env.ctx, { ...quiet });
    expect(result.dryRun).toBe(false);

    expect(await ticketRow(early.ticketId)).toMatchObject({
      holderName: "Pat Person",
      holderEmail: "pat@example.org",
    });
    expect(await mailCount(early.ticketId)).toBe(1);

    const cleared = await ticketRow(due.ticketId);
    expect(cleared.holderName).toBeNull();
    expect(cleared.holderEmail).toBeNull();
    expect(cleared).toMatchObject({ ticketType: 0, admitsUsed: 1, inside: true, status: "valid" });
    expect(await mailCount(due.ticketId)).toBe(0);
    expect(await scanCount(due.ticketId)).toBe(1); // scans live 3 years
  });

  it("deletes scans 3 years after the event, not a day earlier", async () => {
    const early = await seed(3 * 365 - 1);
    const due = await seed(3 * 365);
    await runRetention(env.ctx, { ...quiet });
    expect(await scanCount(early.ticketId)).toBe(1);
    expect(await scanCount(due.ticketId)).toBe(0);
    const kept = await ticketRow(due.ticketId);
    expect(kept.admitsUsed).toBe(1); // counts stay
    expect(kept.holderName).toBeNull();
  });

  it("a dry run reports the counts and changes nothing; a second real run finds nothing left", async () => {
    const old = await seed(4 * 365);
    const dry = await runRetention(env.ctx, { dryRun: true, ...quiet });
    expect(dry).toMatchObject({
      dryRun: true,
      ticketsCleared: 1,
      emailsDeleted: 1,
      scansDeleted: 1,
    });
    expect((await ticketRow(old.ticketId)).holderName).toBe("Pat Person");
    expect(await scanCount(old.ticketId)).toBe(1);
    expect(await mailCount(old.ticketId)).toBe(1);

    const real = await runRetention(env.ctx, { ...quiet });
    expect(real).toMatchObject({ ticketsCleared: 1, emailsDeleted: 1, scansDeleted: 1 });
    expect((await ticketRow(old.ticketId)).holderName).toBeNull();
    expect(await runRetention(env.ctx, { ...quiet })).toMatchObject({
      ticketsCleared: 0,
      emailsDeleted: 0,
      scansDeleted: 0,
    });
  });

  it("durations are configurable", async () => {
    const e = await seed(10);
    await runRetention(env.ctx, { piiDays: 10, scanDays: 30, ...quiet });
    expect((await ticketRow(e.ticketId)).holderName).toBeNull();
    expect(await scanCount(e.ticketId)).toBe(1);
    await runRetention(env.ctx, { piiDays: 10, scanDays: 10, ...quiet });
    expect(await scanCount(e.ticketId)).toBe(0);
  });

  it("an event that has not ended is never touched", async () => {
    const live = await seed(-5);
    await runRetention(env.ctx, { piiDays: 0, scanDays: 0, ...quiet });
    expect((await ticketRow(live.ticketId)).holderName).toBe("Pat Person");
    expect(await scanCount(live.ticketId)).toBe(1);
  });

  it("is due once per UTC day, after the configured hour", () => {
    const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);
    expect(retentionDue(at("2026-10-22T01:59:00Z"), 2, undefined)).toBeUndefined();
    expect(retentionDue(at("2026-10-22T02:00:00Z"), 2, undefined)).toBe("2026-10-22");
    expect(retentionDue(at("2026-10-22T09:00:00Z"), 2, "2026-10-22")).toBeUndefined();
    expect(retentionDue(at("2026-10-23T02:30:00Z"), 2, "2026-10-22")).toBe("2026-10-23");
  });
});
