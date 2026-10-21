import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { getTableConfig as mysqlConfig } from "drizzle-orm/mysql-core";
import { getTableConfig as sqliteConfig } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { mysqlSchema, sqliteSchema } from "../src";

const here = dirname(fileURLToPath(import.meta.url));
const sqliteMigrations = resolve(here, "../drizzle/sqlite");

function freshDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: sqliteMigrations });
  return { sqlite, db };
}

const tables = [
  "events",
  "staff",
  "ticketTypes",
  "tickets",
  "devices",
  "enrolmentCodes",
  "scans",
  "emailQueue",
] as const;

describe("schemas", () => {
  it("define the same tables and columns for MariaDB and SQLite", () => {
    for (const t of tables) {
      const m = mysqlConfig(mysqlSchema[t]);
      const s = sqliteConfig(sqliteSchema[t]);
      expect(m.name).toBe(s.name);
      expect(m.columns.map((c) => c.name)).toEqual(s.columns.map((c) => c.name));
      expect(m.checks.map((c) => c.name).sort()).toEqual(s.checks.map((c) => c.name).sort());
      expect(m.indexes.map((i) => i.config.name).sort()).toEqual(
        s.indexes.map((i) => i.config.name).sort(),
      );
    }
  });

  it("have mysql migrations that create every table", () => {
    const dir = resolve(here, "../drizzle/mysql");
    const file = readdirSync(dir).find((f) => f.endsWith(".sql"))!;
    const sql = readFileSync(resolve(dir, file), "utf8");
    for (const name of [
      "events",
      "staff",
      "ticket_types",
      "tickets",
      "devices",
      "enrolment_codes",
      "scans",
      "email_queue",
    ]) {
      expect(sql).toContain("CREATE TABLE `" + name + "`");
    }
  });
});

describe("SQLite migrations", () => {
  const now = 1_800_000_000;
  const event = {
    name: "Fest",
    startsAt: now,
    endsAt: now + 3600,
    encKeyRef: "enc",
    signKeyId: 1,
    gates: ["A", "B"],
  };

  it("apply to an in-memory database and create every table", () => {
    const { sqlite } = freshDb();
    const names = sqlite
      .prepare("select name from sqlite_master where type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const n of [
      "events",
      "staff",
      "ticket_types",
      "tickets",
      "devices",
      "enrolment_codes",
      "scans",
      "email_queue",
    ]) {
      expect(names).toContain(n);
    }
  });

  it("round-trips a ticket with binary id and nonce", () => {
    const { db } = freshDb();
    const [e] = db.insert(sqliteSchema.events).values(event).returning().all();
    db.insert(sqliteSchema.ticketTypes)
      .values({ eventId: e!.id, idx: 0, name: "GA", capacity: 2 })
      .run();
    const id = Uint8Array.from({ length: 16 }, (_, i) => i);
    db.insert(sqliteSchema.tickets)
      .values({
        id,
        eventId: e!.id,
        ticketType: 0,
        tokenNonce: new Uint8Array(12),
        entryMode: "single",
        maxAdmits: 1,
        issuedAt: now,
        updatedAt: now,
      })
      .run();
    const row = db
      .select()
      .from(sqliteSchema.tickets)
      .where(eq(sqliteSchema.tickets.eventId, e!.id))
      .get()!;
    expect(Array.from(row.id)).toEqual(Array.from(id));
    expect(row).toMatchObject({ inside: false, admitsUsed: 0, status: "valid", gateMask: 0 });
  });

  it("enforces CHECK constraints", () => {
    const { sqlite, db } = freshDb();
    const [e] = db.insert(sqliteSchema.events).values(event).returning().all();
    const bad = (idx: number, extra: Record<string, unknown>) => () =>
      db
        .insert(sqliteSchema.ticketTypes)
        .values({ eventId: e!.id, idx, name: "x", ...extra })
        .run();
    expect(bad(0, { earlyEntryMin: 10 })).toThrow(/CHECK/);
    expect(bad(1, { earlyEntryMin: 31 })).toThrow(/CHECK/);
    expect(bad(2, { entryMode: "limited" })).toThrow(/CHECK/);
    expect(bad(3, { entryMode: "limited", maxAdmits: 1 })).toThrow(/CHECK/);
    expect(bad(4, { entryMode: "single", maxAdmits: 5 })).toThrow(/CHECK/);
    expect(bad(5, { entryMode: "sometimes" })).toThrow(/CHECK/);
    expect(bad(6, { capacity: 1, issued: 2 })).toThrow(/CHECK/);
    expect(bad(7, { entryMode: "limited", maxAdmits: 3, earlyEntryMin: 30 })).not.toThrow();
    expect(() =>
      sqlite
        .prepare("insert into staff (id, name, pin_hash, role) values (?, 'x', 'h', 'scanner')")
        .run(randomUUID()),
    ).toThrow(/CHECK/);
  });

  it("enforces ticket_types composite key, the capacity guard and foreign keys", () => {
    const { sqlite, db } = freshDb();
    const [e] = db.insert(sqliteSchema.events).values(event).returning().all();
    db.insert(sqliteSchema.ticketTypes)
      .values({ eventId: e!.id, idx: 0, name: "GA", capacity: 1 })
      .run();
    expect(() =>
      db.insert(sqliteSchema.ticketTypes).values({ eventId: e!.id, idx: 0, name: "dup" }).run(),
    ).toThrow();
    // The spec's capacity transaction: only one of two attempts changes a row.
    const take = sqlite.prepare(
      "UPDATE ticket_types SET issued = issued + 1 WHERE event_id = ? AND idx = ? AND (capacity IS NULL OR issued < capacity)",
    );
    expect(take.run(e!.id, 0).changes).toBe(1);
    expect(take.run(e!.id, 0).changes).toBe(0);
    expect(() =>
      db.insert(sqliteSchema.ticketTypes).values({ eventId: 999, idx: 0, name: "orphan" }).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("scans are keyed by the device-generated id, so replays are idempotent", () => {
    const { db } = freshDb();
    const [e] = db.insert(sqliteSchema.events).values(event).returning().all();
    const id = new Uint8Array(16).fill(7);
    db.insert(sqliteSchema.tickets)
      .values({
        id,
        eventId: e!.id,
        ticketType: 0,
        tokenNonce: new Uint8Array(12),
        entryMode: "single",
        maxAdmits: 1,
        issuedAt: now,
        updatedAt: now,
      })
      .run();
    const scan = {
      id: randomUUID(),
      ticketId: id,
      gate: "A",
      direction: "entry",
      scannedAt: now,
      result: "admitted",
      offline: false,
    };
    db.insert(sqliteSchema.scans).values(scan).run();
    db.insert(sqliteSchema.scans).values(scan).onConflictDoNothing().run();
    expect(db.select().from(sqliteSchema.scans).all()).toHaveLength(1);
    expect(() =>
      db
        .insert(sqliteSchema.scans)
        .values({ ...scan, id: randomUUID(), result: "teleported" })
        .run(),
    ).toThrow(/CHECK/);
  });
});
