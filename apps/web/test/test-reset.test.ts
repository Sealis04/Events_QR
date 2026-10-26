import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mysqlSchema } from "@events-qr/core";
import {
  accountPins,
  dropAllTables,
  resetRefusal,
  TEST_ACCOUNTS,
} from "../../../scripts/test-reset";
import { EVENT_NAME, seedRehearsal, sheetEntries } from "../../../scripts/rehearsal-seed";
import { GET } from "../src/app/api/health/route";
import { verifyPin } from "../src/server/auth";
import { runMigrations } from "../src/server/db";
import { createStaff } from "../src/server/staff";
import { createTestEnv, dbAvailable, makeStaff, type TestEnv } from "./helpers";

const testEnv = {
  INSTANCE_LABEL: "TEST",
  DB_NAME: "events_qr_test",
  PUBLIC_URL: "https://test.example.org",
  PRODUCTION_URL: "https://tickets.example.org",
};

describe("test reset guard", () => {
  it("needs --yes", () => {
    expect(resetRefusal({ yes: false, env: testEnv })).toMatch(/--yes/);
  });
  it("needs INSTANCE_LABEL, so production (which has none) is refused", () => {
    expect(resetRefusal({ yes: true, env: { ...testEnv, INSTANCE_LABEL: "" } })).toMatch(
      /INSTANCE_LABEL/,
    );
    expect(resetRefusal({ yes: true, env: { ...testEnv, INSTANCE_LABEL: undefined } })).toMatch(
      /INSTANCE_LABEL/,
    );
  });
  it("needs a database name containing test", () => {
    expect(resetRefusal({ yes: true, env: { ...testEnv, DB_NAME: "events_qr" } })).toMatch(
      /DB_NAME/,
    );
    expect(resetRefusal({ yes: true, env: { ...testEnv, DB_NAME: undefined } })).toMatch(/DB_NAME/);
  });
  it("refuses when PUBLIC_URL is the production URL", () => {
    expect(
      resetRefusal({
        yes: true,
        env: { ...testEnv, PUBLIC_URL: "https://tickets.example.org/" },
      }),
    ).toMatch(/production/);
  });
  it("allows the test copy", () => {
    expect(resetRefusal({ yes: true, env: testEnv })).toBeUndefined();
  });
  it("takes account PINs from the environment, else the defaults", () => {
    const pins = accountPins({ TEST_STAFF_PIN: "999999" });
    expect(pins.find((a) => a.role === "staff")!.pin).toBe("999999");
    expect(pins.find((a) => a.role === "admin")!.pin).toBe(TEST_ACCOUNTS[0]!.pin);
  });
});

// The route is typed after its VM handler (no arguments); at runtime it takes the request.
const health = GET as unknown as (req: Request) => Promise<Response>;

describe("health reports the instance label", () => {
  const before = process.env.INSTANCE_LABEL;
  afterEach(() => {
    if (before === undefined) delete process.env.INSTANCE_LABEL;
    else process.env.INSTANCE_LABEL = before;
  });
  it("includes it when set and leaves it out otherwise", async () => {
    process.env.INSTANCE_LABEL = "TEST";
    const on = await (await health(new Request("http://x/api/health"))).json();
    expect(on).toMatchObject({ ok: true, mode: "server", instance_label: "TEST" });
    delete process.env.INSTANCE_LABEL;
    const off = await (await health(new Request("http://x/api/health"))).json();
    expect(off).not.toHaveProperty("instance_label");
  });
});

describe.skipIf(!dbAvailable)("test reset against a database", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => env?.close());

  it("empties the database, re-migrates, recreates the accounts and seeds the rehearsal", async () => {
    // Something to throw away first: an extra admin and a seeded rehearsal.
    const old = await makeStaff(env, "admin", "Old Admin");
    await seedRehearsal(env.ctx, { id: old.id, role: "admin" });

    const dropped = await dropAllTables(env.handle.pool);
    expect(dropped).toBeGreaterThan(5);
    await runMigrations(env.handle.db);
    expect(await env.handle.db.select().from(mysqlSchema.staff)).toHaveLength(0);
    expect(await env.handle.db.select().from(mysqlSchema.tickets)).toHaveLength(0);

    let adminId = "";
    for (const a of accountPins({})) {
      const s = await createStaff(
        { db: env.handle.db },
        { name: a.name, pin: a.pin, role: a.role },
      );
      if (a.role === "admin") adminId = s.id;
    }
    const staff = await env.handle.db.select().from(mysqlSchema.staff);
    expect(staff.map((s) => s.name).sort()).toEqual(TEST_ACCOUNTS.map((a) => a.name).sort());
    const admin = staff.find((s) => s.role === "admin")!;
    expect(await verifyPin(TEST_ACCOUNTS[0]!.pin, admin.pinHash)).toBe(true);

    const eventId = await seedRehearsal(env.ctx, { id: adminId, role: "admin" });
    const [event] = await env.handle.db.select().from(mysqlSchema.events);
    expect(event!.name).toBe(EVENT_NAME);
    expect(await sheetEntries(env.ctx, eventId)).toHaveLength(50);
  });
});
