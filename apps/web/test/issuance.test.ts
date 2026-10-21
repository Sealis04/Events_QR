import { eq } from "drizzle-orm";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  bytesToHex,
  decodeEntryRule,
  hexToBytes,
  mysqlSchema,
  verifyToken,
} from "@events-qr/core";
import { POST as createEvent } from "../src/app/api/events/route";
import { GET as getEvent, PATCH as patchEvent } from "../src/app/api/events/[id]/route";
import { GET as listTickets, POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as addType } from "../src/app/api/events/[id]/ticket-types/route";
import { PATCH as patchType } from "../src/app/api/events/[id]/ticket-types/[idx]/route";
import { POST as cancel } from "../src/app/api/tickets/[id]/cancel/route";
import { POST as resend } from "../src/app/api/tickets/[id]/resend/route";
import { POST as transfer } from "../src/app/api/tickets/[id]/transfer/route";
import { tokenForRow } from "../src/server/tickets";
import { loadEvent } from "../src/server/events";
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

describe.skipIf(!dbAvailable)("ticket issuance (MariaDB)", () => {
  let env: TestEnv;
  let admin: TestStaff;
  let supervisor: TestStaff;
  let staff: TestStaff;
  let eventId: number;

  const gen = (body: Record<string, unknown>, who: TestStaff = staff) =>
    call(generate, {
      staff: who,
      params: { id: String(eventId) },
      body: { idempotency_key: newKey(), ...body },
    });

  beforeAll(async () => {
    env = await createTestEnv();
    [admin, supervisor, staff] = await Promise.all([
      makeStaff(env, "admin"),
      makeStaff(env, "supervisor"),
      makeStaff(env, "staff"),
    ]);
    const created = await call(createEvent, {
      staff: admin,
      body: eventBody(env.clock.now + 86400),
    });
    expect(created.status).toBe(201);
    eventId = created.json.id;
  });
  afterAll(() => env.close());

  it("creates an event with an encrypted AES key and never returns it", async () => {
    const [row] = await env.handle.db
      .select()
      .from(mysqlSchema.events)
      .where(eq(mysqlSchema.events.id, eventId));
    expect(row!.encKeyRef).toMatch(/^v1:/);
    const view = await call(getEvent, { staff, params: { id: String(eventId) } });
    expect(view.status).toBe(200);
    expect(view.json.ticket_types).toHaveLength(3);
    expect(view.text).not.toContain(row!.encKeyRef);
    expect(view.text.toLowerCase()).not.toContain("enc_key");
  });

  it("generates a ticket whose QR decodes to a token that verifies with core", async () => {
    const res = await gen({ ticket_type: 1, holder_name: "Jane Doe", note: "sponsor guest" });
    expect(res.status).toBe(201);
    expect(() => api.createTicketsResponse.parse(res.json)).not.toThrow();
    const t = res.json.tickets[0];

    // The PNG is a real QR code whose content is exactly the token.
    const png = PNG.sync.read(Buffer.from(t.qr_png.split(",")[1], "base64"));
    expect(png.width).toBeGreaterThanOrEqual(300);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(t.token);
    expect(t.qr_svg).toContain("<svg");

    const key = await env.eventKeyFor(eventId);
    const result = await verifyToken(t.token, env.signer.publicKeys(), key, eventId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(bytesToHex(result.payload.ticketId)).toBe(t.ticket_id);
    expect(result.payload.ticketType).toBe(1);
    expect(result.payload.gateMask).toBe(0b100); // the VIP type's default
    expect(decodeEntryRule(result.payload.entryRule)).toEqual({ mode: "limited", maxAdmits: 3 });
    expect(t.short_id).toBe(t.ticket_id.slice(-6));
    // Wrong event is rejected by core.
    expect((await verifyToken(t.token, env.signer.publicKeys(), key, eventId + 1)).ok).toBe(false);

    const [row] = await env.handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, Buffer.from(hexToBytes(t.ticket_id))));
    expect(row).toMatchObject({
      issuedBy: staff.id,
      note: "sponsor guest",
      holderName: "Jane Doe",
      status: "valid",
    });
  });

  it("re-send rebuilds a byte-identical token from the stored nonce", async () => {
    const res = await gen({ ticket_type: 2, holder_name: "Pat", holder_email: "pat@example.org" });
    const t = res.json.tickets[0];
    const event = await loadEvent(env.handle.db, eventId);
    const [row] = await env.handle.db
      .select()
      .from(tickets)
      .where(eq(tickets.id, Buffer.from(hexToBytes(t.ticket_id))));
    expect(await tokenForRow(env.ctx, event, row!)).toBe(t.token);
    expect(await tokenForRow(env.ctx, event, row!)).toBe(t.token);

    const queued = await call(resend, { staff: admin, params: { id: t.ticket_id }, body: {} });
    expect(queued.status).toBe(200);
    expect(() => api.resendTicketResponse.parse(queued.json)).not.toThrow();
    // Generation queued one email (holder_email), the re-send a second.
    const rows = await env.handle.db
      .select()
      .from(emailQueue)
      .where(eq(emailQueue.ticketId, row!.id));
    expect(rows.map((r) => r.toEmail)).toEqual(["pat@example.org", "pat@example.org"]);

    // The same idempotency-free generate response and a later fetch agree on the token too.
    const again = await call(listTickets, {
      staff,
      params: { id: String(eventId) },
      query: { q: t.short_id },
    });
    expect(again.json.tickets.map((x: { ticket_id: string }) => x.ticket_id)).toContain(
      t.ticket_id,
    );
  });

  it("re-send needs an address and refuses cancelled tickets", async () => {
    const t = (await gen({ ticket_type: 2, holder_name: "No Mail" })).json.tickets[0];
    expect(
      (await call(resend, { staff: admin, params: { id: t.ticket_id }, body: {} })).status,
    ).toBe(400);
    expect(
      (
        await call(resend, {
          staff: admin,
          params: { id: t.ticket_id },
          body: { email: "x@example.org" },
        })
      ).status,
    ).toBe(200);
    await call(cancel, { staff: admin, params: { id: t.ticket_id }, body: {} });
    expect(
      (
        await call(resend, {
          staff: admin,
          params: { id: t.ticket_id },
          body: { email: "x@example.org" },
        })
      ).status,
    ).toBe(409);
  });

  it("numbers batch names when the name is blank and requires one otherwise", async () => {
    const batch = await gen({ ticket_type: 2, quantity: 12 });
    expect(batch.status).toBe(201);
    expect(
      batch.json.tickets.map((t: { holder_name: string }) => t.holder_name).slice(0, 2),
    ).toEqual(["Staff 01", "Staff 02"]);
    expect(new Set(batch.json.tickets.map((t: { ticket_id: string }) => t.ticket_id)).size).toBe(
      12,
    );
    expect((await gen({ ticket_type: 2 })).status).toBe(400);
  });

  it("does not oversell: 50 parallel generate calls on a type with capacity 20 create exactly 20", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => gen({ ticket_type: 0, holder_name: `Racer ${i}` })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(20);
    const rejected = results.filter((r) => r.status !== 201);
    expect(rejected).toHaveLength(30);
    expect(new Set(rejected.map((r) => r.status))).toEqual(new Set([409]));
    expect(rejected[0]!.json.error.code).toBe("sold_out");

    const [type] = await env.handle.db
      .select()
      .from(ticketTypes)
      .where(eq(ticketTypes.eventId, eventId));
    expect(type).toMatchObject({ idx: 0, issued: 20, capacity: 20 });
    const rows = await env.handle.db.select().from(tickets).where(eq(tickets.ticketType, 0));
    expect(rows.filter((r) => r.eventId === eventId)).toHaveLength(20);
  });

  it("a batch is all or nothing against capacity", async () => {
    await call(addType, {
      staff: admin,
      params: { id: String(eventId) },
      body: { name: "Tiny", capacity: 3 },
    });
    const view = await call(getEvent, { staff, params: { id: String(eventId) } });
    const idx = view.json.ticket_types.find((t: { name: string }) => t.name === "Tiny").idx;
    const over = await gen({ ticket_type: idx, quantity: 4 });
    expect(over.status).toBe(409);
    expect(over.json.error.details).toEqual({ remaining: 3 });
    expect((await gen({ ticket_type: idx, quantity: 3 })).status).toBe(201);
    expect((await gen({ ticket_type: idx, holder_name: "late" })).status).toBe(409);
  });

  describe("idempotency", () => {
    it("returns the same tickets for a retried key and creates nothing new", async () => {
      const body = { idempotency_key: newKey(), ticket_type: 2, quantity: 3, holder_name: "Crew" };
      const first = await call(generate, { staff, params: { id: String(eventId) }, body });
      const second = await call(generate, { staff, params: { id: String(eventId) }, body });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.json).toEqual(first.json);
      const [type] = await env.handle.db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId))
        .then((rows) => rows.filter((r) => r.idx === 2));
      const issuedBefore = type!.issued;
      await call(generate, { staff, params: { id: String(eventId) }, body });
      const [after] = await env.handle.db
        .select()
        .from(ticketTypes)
        .where(eq(ticketTypes.eventId, eventId))
        .then((rows) => rows.filter((r) => r.idx === 2));
      expect(after!.issued).toBe(issuedBefore);
    });

    it("concurrent retries of one key create one set of tickets", async () => {
      const body = { idempotency_key: newKey(), ticket_type: 2, quantity: 2, holder_name: "Twin" };
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          call(generate, { staff, params: { id: String(eventId) }, body }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      const ids = new Set(
        results.map((r) =>
          JSON.stringify(r.json.tickets.map((t: { ticket_id: string }) => t.ticket_id)),
        ),
      );
      expect(ids.size).toBe(1);
    });

    it("rejects a key reused for a different request", async () => {
      const key = newKey();
      await call(generate, {
        staff,
        params: { id: String(eventId) },
        body: { idempotency_key: key, ticket_type: 2, holder_name: "A" },
      });
      const clash = await call(generate, {
        staff,
        params: { id: String(eventId) },
        body: { idempotency_key: key, ticket_type: 2, holder_name: "B" },
      });
      expect(clash.status).toBe(422);
      expect(clash.json.error.code).toBe("idempotency_conflict");
    });

    it("does not remember a key whose request failed", async () => {
      const key = newKey();
      const body = { idempotency_key: key, ticket_type: 0, holder_name: "Too late" };
      expect((await call(generate, { staff, params: { id: String(eventId) }, body })).status).toBe(
        409,
      ); // GA sold out
      await call(patchType, {
        staff: admin,
        params: { id: String(eventId), idx: "0" },
        body: { capacity: 25 },
      });
      expect((await call(generate, { staff, params: { id: String(eventId) }, body })).status).toBe(
        201,
      );
    });
  });

  it("only a supervisor can override the entry rule or lock gates per ticket", async () => {
    const override = { ticket_type: 2, holder_name: "Guest", entry_rule: { mode: "single" } };
    expect((await gen(override, staff)).status).toBe(403);
    const ok = await gen(override, supervisor);
    expect(ok.status).toBe(201);
    const key = await env.eventKeyFor(eventId);
    const v = await verifyToken(ok.json.tickets[0].token, env.signer.publicKeys(), key, eventId);
    expect(v.ok && decodeEntryRule(v.payload.entryRule)).toEqual({ mode: "single", maxAdmits: 1 });
    // Same rule as the type is not an override.
    expect(
      (await gen({ ticket_type: 2, holder_name: "Same", entry_rule: { mode: "unlimited" } }, staff))
        .status,
    ).toBe(201);
    // A gate restriction and a slot are open to any staff member and land in the signed QR.
    const slotted = await gen({
      ticket_type: 2,
      holder_name: "Slot",
      gate_mask: 0b11,
      slot: { start: 17 * 60, end: 23 * 60 },
    });
    const sv = await verifyToken(
      slotted.json.tickets[0].token,
      env.signer.publicKeys(),
      key,
      eventId,
    );
    expect(sv.ok && [sv.payload.gateMask, sv.payload.slotStart, sv.payload.slotEnd]).toEqual([
      0b11, 1020, 1380,
    ]);
    expect((await gen({ ticket_type: 2, holder_name: "Bad gate", gate_mask: 0b1000 })).status).toBe(
      400,
    );
  });

  it("validates ticket type and event", async () => {
    expect((await gen({ ticket_type: 99, holder_name: "x" })).status).toBe(404);
    expect(
      (
        await call(generate, {
          staff,
          params: { id: "9999" },
          body: { idempotency_key: newKey(), ticket_type: 0, holder_name: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await gen({ ticket_type: 2, holder_name: "x", holder_email: "not-an-email" })).status,
    ).toBe(400);
  });

  it("cancel sets the status and bumps updated_at; cancelling twice is harmless", async () => {
    const t = (await gen({ ticket_type: 2, holder_name: "Cancelled" })).json.tickets[0];
    env.clock.now += 100;
    const res = await call(cancel, {
      staff: admin,
      params: { id: t.ticket_id },
      body: { reason: "refund" },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      ticket_id: t.ticket_id,
      status: "cancelled",
      updated_at: env.clock.now,
    });
    env.clock.now += 100;
    const again = await call(cancel, { staff: admin, params: { id: t.ticket_id }, body: {} });
    expect(again.json.updated_at).toBe(res.json.updated_at);
    expect(
      (await call(cancel, { staff: admin, params: { id: "00".repeat(16) }, body: {} })).status,
    ).toBe(404);
  });

  it("transfer cancels the old ticket and issues a new one without using extra capacity", async () => {
    const tiny = (
      await call(addType, {
        staff: admin,
        params: { id: String(eventId) },
        body: { name: "Solo", capacity: 1 },
      })
    ).json.idx;
    const old = (await gen({ ticket_type: tiny, holder_name: "Alice" })).json.tickets[0];
    expect((await gen({ ticket_type: tiny, holder_name: "Overflow" })).status).toBe(409);

    const res = await call(transfer, {
      staff: admin,
      params: { id: old.ticket_id },
      body: { holder_name: "Bob", holder_email: "bob@example.org" },
    });
    expect(res.status).toBe(201);
    expect(res.json.cancelled_ticket_id).toBe(old.ticket_id);
    expect(res.json.ticket.holder_name).toBe("Bob");
    expect(res.json.ticket.ticket_id).not.toBe(old.ticket_id);

    const rows = await env.handle.db.select().from(tickets).where(eq(tickets.ticketType, tiny));
    const mine = rows.filter((r) => r.eventId === eventId);
    expect(mine.map((r) => r.status).sort()).toEqual(["cancelled", "valid"]);
    const [type] = (
      await env.handle.db.select().from(ticketTypes).where(eq(ticketTypes.eventId, eventId))
    ).filter((r) => r.idx === tiny);
    expect(type!.issued).toBe(1);
    // The old ticket is dead and can't be moved again.
    expect(
      (
        await call(transfer, {
          staff: admin,
          params: { id: old.ticket_id },
          body: { holder_name: "Carol" },
        })
      ).status,
    ).toBe(409);
    const emails = await env.handle.db.select().from(emailQueue);
    expect(emails.some((e) => e.toEmail === "bob@example.org")).toBe(true);
  });

  it("keeps the gate order append-only once tickets exist", async () => {
    const patch = (body: Record<string, unknown>) =>
      call(patchEvent, { staff: admin, params: { id: String(eventId) }, body });
    expect((await patch({ gates: ["Gate A", "Gate B", "VIP door", "Gate D"] })).status).toBe(200);
    expect(
      (await patch({ gates: ["Gate B", "Gate A", "VIP door", "Gate D"] })).json.error.code,
    ).toBe("gates_append_only");
    expect((await patch({ gates: ["Gate A", "Gate B"] })).status).toBe(409);
    expect((await patch({ gates: ["Gate A", "gate a"] })).status).toBe(400); // duplicate names
    expect((await patch({ starts_at: env.clock.now })).json.error.code).toBe("tickets_exist");
    const ok = await patch({ name: "Summer Fest 2027", venue: "Main Hall" });
    expect(ok.json).toMatchObject({ name: "Summer Fest 2027", venue: "Main Hall" });
    // 17+ gates are rejected by the schema.
    expect((await patch({ gates: Array.from({ length: 17 }, (_, i) => `G${i}`) })).status).toBe(
      400,
    );
  });

  it("before any ticket exists the gates can be reordered", async () => {
    const fresh = await call(createEvent, { staff: admin, body: eventBody(env.clock.now + 5000) });
    const res = await call(patchEvent, {
      staff: admin,
      params: { id: String(fresh.json.id) },
      body: { gates: ["VIP door", "Gate A"] },
    });
    // Type "VIP" is locked to bit 2 (the third gate), which would disappear: refused until the type is changed.
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("gate_in_use");
  });

  it("edits ticket types without dropping below what was issued", async () => {
    const res = await call(patchType, {
      staff: admin,
      params: { id: String(eventId), idx: "0" },
      body: { capacity: 5 },
    });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("below_issued");
    const ok = await call(patchType, {
      staff: admin,
      params: { id: String(eventId), idx: "2" },
      body: { early_entry_min: 30, name: "Crew" },
    });
    expect(ok.json).toMatchObject({ name: "Crew", early_entry_min: 30 });
    expect(
      (
        await call(patchType, {
          staff: admin,
          params: { id: String(eventId), idx: "2" },
          body: { early_entry_min: 5 },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(addType, {
          staff: admin,
          params: { id: String(eventId) },
          body: { idx: 2, name: "dup" },
        })
      ).status,
    ).toBe(409);
  });
});
