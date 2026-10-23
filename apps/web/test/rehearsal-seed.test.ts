import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import {
  EVENT_NAME,
  refusal,
  renderSheet,
  scenarioOf,
  seedRehearsal,
  sheetEntries,
} from "../../../scripts/rehearsal-seed";
import { createTestEnv, dbAvailable, makeStaff, type TestEnv } from "./helpers";

const tally = (xs: string[]) =>
  xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

describe("rehearsal seed guard", () => {
  it("needs --yes", () => {
    expect(refusal({ yes: false, env: {} })).toMatch(/--yes/);
  });
  it("refuses the production URL, from PUBLIC_URL or --target-url", () => {
    const env = {
      PRODUCTION_URL: "https://tickets.example.org/",
      PUBLIC_URL: "https://tickets.example.org",
    };
    expect(refusal({ yes: true, env })).toMatch(/production/);
    expect(
      refusal({
        yes: true,
        env: { PRODUCTION_URL: env.PRODUCTION_URL },
        targetUrl: "https://tickets.example.org",
      }),
    ).toMatch(/production/);
  });
  it("allows staging, and refuses NODE_ENV=production without a way to tell them apart", () => {
    const env = {
      PRODUCTION_URL: "https://tickets.example.org",
      PUBLIC_URL: "https://staging.example.org",
    };
    expect(refusal({ yes: true, env })).toBeUndefined();
    expect(refusal({ yes: true, env: {} })).toBeUndefined();
    expect(refusal({ yes: true, env: { NODE_ENV: "production" } })).toMatch(/PRODUCTION_URL/);
  });
});

describe.skipIf(!dbAvailable)("rehearsal seed", () => {
  let env: TestEnv;
  let eventId: number;
  beforeAll(async () => {
    env = await createTestEnv();
    const admin = await makeStaff(env, "admin");
    eventId = await seedRehearsal(env.ctx, { id: admin.id, role: "admin" });
  });
  afterAll(async () => {
    await env.close();
  });

  it("makes the event with two gates and five ticket types", async () => {
    const [event] = await env.handle.db
      .select()
      .from(mysqlSchema.events)
      .where(eq(mysqlSchema.events.id, eventId));
    expect(event!.name).toBe(EVENT_NAME);
    expect(event!.gates).toEqual(["Gate A", "Gate B"]);
    const types = await env.handle.db.select().from(mysqlSchema.ticketTypes);
    expect(types.map((t) => t.name).sort()).toEqual(
      ["Gate B only", "General", "Re-entry (3)", "Timed", "VIP"].sort(),
    );
  });

  it("makes 50 tickets in the field test's mix", async () => {
    const entries = await sheetEntries(env.ctx, eventId);
    expect(entries).toHaveLength(50);
    expect(tally(entries.map((e) => e.scenario))).toEqual({
      single: 21,
      cancelled: 1,
      "transfer-old": 1,
      "transfer-new": 1,
      "reentry-3": 8,
      unlimited: 6,
      "gate-b-only": 6,
      "slot-open": 3,
      "slot-early": 2,
      "slot-ended": 1,
    });
    expect(new Set(entries.map((e) => e.shortId)).size).toBe(50);
  });

  it("has the cancelled and transferred tickets in the right state", async () => {
    const rows = await env.handle.db.select().from(mysqlSchema.tickets);
    const byScenario = (s: string) => rows.filter((r) => scenarioOf(r) === s);
    expect(byScenario("cancelled")[0]!.status).toBe("cancelled");
    expect(byScenario("transfer-old")[0]!.status).toBe("cancelled");
    expect(byScenario("transfer-new")[0]!.status).toBe("valid");
    const gateB = byScenario("gate-b-only");
    expect(gateB.every((r) => r.gateMask === 0b10)).toBe(true);
    const re = byScenario("reentry-3");
    expect(re.every((r) => r.entryMode === "limited" && r.maxAdmits === 3)).toBe(true);
    expect(byScenario("unlimited").every((r) => r.entryMode === "unlimited")).toBe(true);
    const now = env.ctx.now();
    expect(byScenario("slot-open").every((r) => r.slotStart! <= now && r.slotEnd === null)).toBe(
      true,
    );
    expect(byScenario("slot-early").every((r) => r.slotStart! > now)).toBe(true);
    expect(byScenario("slot-ended").every((r) => r.slotEnd! < now)).toBe(true);
  });

  it("is idempotent: a second run re-uses the event and prints the same codes", async () => {
    const before = await sheetEntries(env.ctx, eventId);
    const admin = await makeStaff(env, "admin");
    const again = await seedRehearsal(env.ctx, { id: admin.id, role: "admin" });
    expect(again).toBe(eventId);
    const events = await env.handle.db.select().from(mysqlSchema.events);
    expect(events).toHaveLength(1);
    const after = await sheetEntries(env.ctx, eventId);
    expect(after).toHaveLength(50);
    expect(after.map((e) => [e.shortId, e.png])).toEqual(before.map((e) => [e.shortId, e.png]));
  });

  it("writes a sheet with one captioned QR per ticket", async () => {
    const html = renderSheet(await sheetEntries(env.ctx, eventId));
    expect(html.match(/<figure>/g)).toHaveLength(50);
    expect(html).toContain("transfer-new");
    expect(html).toContain("Gate B only");
    expect(html.match(/src="data:image\/png;base64,/g)).toHaveLength(50);
  });
});
