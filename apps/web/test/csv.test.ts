import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, mysqlSchema } from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { POST as importTickets } from "../src/app/api/events/[id]/tickets/import/route";
import { parseCsv } from "../src/server/csv";
import {
  call,
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  type TestEnv,
  type TestStaff,
} from "./helpers";

const { tickets, ticketTypes, emailQueue } = mysqlSchema;

describe("parseCsv", () => {
  it("handles quotes, commas, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n,z\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["", "z"],
    ]);
  });
  it("keeps newlines inside quotes", () => {
    expect(parseCsv('a\n"line1\nline2",b')).toEqual([["a"], ["line1\nline2", "b"]]);
  });
});

describe.skipIf(!dbAvailable)("POST /events/{id}/tickets/import (MariaDB)", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let eventId: number;

  const run = (csv: string, key?: string) =>
    call(importTickets, {
      staff: admin,
      params: { id: String(eventId) },
      body: { csv, ...(key ? { idempotency_key: key } : {}) },
    });

  beforeAll(async () => {
    env = await createTestEnv();
    admin = await makeStaff(env, "admin");
    eventId = (
      await call(createEvent, {
        staff: admin,
        body: eventBody(env.clock.now + 86400, {
          ticket_types: [
            { idx: 0, name: "GA", capacity: 3 },
            { idx: 1, name: "VIP" },
          ],
        }),
      })
    ).json.id;
  });
  afterAll(() => env.close());

  it("imports rows through the capacity transaction and reports row errors", async () => {
    const csv = [
      "holder_name,holder_email,ticket_type,note",
      "Ann,ann@example.org,GA,",
      '"Brown, Bob",,0,"table 4"',
      "Cy,not-an-email,GA,",
      "Di,di@example.org,vip,",
      ",,GA,",
      "Ed,,Mystery,",
      "Flo,,GA,",
      "Gus,,GA,",
    ].join("\n");
    const res = await run(csv);
    expect(res.status).toBe(200);
    expect(() => api.importTicketsResponse.parse(res.json)).not.toThrow();
    expect(res.json.created).toBe(4); // Ann, Bob, Di, Flo; Gus finds GA sold out
    const byRow = Object.fromEntries(
      res.json.errors.map((e: { row: number; message: string }) => [e.row, e.message]),
    );
    expect(Object.keys(byRow).map(Number)).toEqual([4, 6, 7, 9]);
    expect(byRow[4]).toMatch(/holder_email/);
    expect(byRow[6]).toMatch(/holder_name/);
    expect(byRow[7]).toMatch(/unknown ticket type "Mystery"/);
    expect(byRow[9]).toMatch(/sold out/);

    const rows = await env.handle.db.select().from(tickets).where(eq(tickets.eventId, eventId));
    expect(rows.map((r) => r.holderName).sort()).toEqual(["Ann", "Brown, Bob", "Di", "Flo"]);
    expect(rows.find((r) => r.holderName === "Brown, Bob")!.note).toBe("table 4");
    const [ga] = (
      await env.handle.db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId))
    ).filter((t) => t.idx === 0);
    expect(ga!.issued).toBe(3);
    const mails = await env.handle.db.select().from(emailQueue);
    expect(mails.map((m) => m.toEmail).sort()).toEqual(["ann@example.org", "di@example.org"]);
    expect(rows.every((r) => r.issuedBy === admin.id)).toBe(true);
  });

  it("a repeated import with the same key issues nothing twice", async () => {
    const csv = "holder_name,ticket_type\nOne,VIP\nTwo,VIP";
    const key = newKey();
    const before = (await env.handle.db.select().from(tickets)).length;
    expect((await run(csv, key)).json).toEqual({ created: 2, errors: [] });
    expect((await run(csv, key)).json).toEqual({ created: 2, errors: [] });
    expect((await env.handle.db.select().from(tickets)).length).toBe(before + 2);
  });

  it("rejects a CSV without the required columns or without rows", async () => {
    expect((await run("name,type\nA,GA")).status).toBe(400);
    expect((await run("holder_name,ticket_type")).json).toEqual({ created: 0, errors: [] });
  });
});
