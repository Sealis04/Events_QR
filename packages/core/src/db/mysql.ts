import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  index,
  int,
  json,
  mysqlTable,
  primaryKey,
  smallint,
  text,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import {
  DEVICE_DIRECTIONS,
  DEVICE_KINDS,
  DIRECTIONS,
  EMAIL_STATUSES,
  ENTRY_MODES,
  NONCE_BYTES,
  SCAN_RESULTS,
  STAFF_ROLES,
  TICKET_ID_BYTES,
  TICKET_STATUSES,
  sqlList,
} from "./shared";

const binary = (length: number) =>
  customType<{ data: Uint8Array; driverData: Uint8Array; config: { length: number } }>({
    dataType: (config) => `binary(${config?.length ?? length})`,
  });
const ticketIdCol = (name: string) => binary(TICKET_ID_BYTES)(name, { length: TICKET_ID_BYTES });
const unixCol = (name: string) => bigint(name, { mode: "number" });
const uuidCol = (name: string) => char(name, { length: 36 });

export const events = mysqlTable("events", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  startsAt: unixCol("starts_at").notNull(),
  endsAt: unixCol("ends_at").notNull(),
  /** The AES-256 event key, encrypted at rest (reference or blob). */
  encKeyRef: text("enc_key_ref").notNull(),
  signKeyId: smallint("sign_key_id").notNull(),
  /** Ordered list of gate names, max 16; position = bit in gate_mask. */
  gates: json("gates").$type<string[]>().notNull(),
  config: json("config").$type<Record<string, unknown>>(),
});

export const staff = mysqlTable(
  "staff",
  {
    id: uuidCol("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    pinHash: text("pin_hash").notNull(),
    role: varchar("role", { length: 16 }).notNull(),
  },
  (t) => [check("ck_staff_role", sql`${t.role} IN (${sql.raw(sqlList(STAFF_ROLES))})`)],
);

export const ticketTypes = mysqlTable(
  "ticket_types",
  {
    eventId: int("event_id")
      .notNull()
      .references(() => events.id),
    idx: smallint("idx").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    capacity: int("capacity"),
    issued: int("issued").notNull().default(0),
    entryMode: varchar("entry_mode", { length: 16 }).notNull().default("single"),
    maxAdmits: smallint("max_admits"),
    gateMask: smallint("gate_mask", { unsigned: true }).notNull().default(0),
    slots: json("slots").$type<{ start: number; end: number }[]>(),
    earlyEntryMin: smallint("early_entry_min").notNull().default(15),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.idx] }),
    check("ck_ticket_types_capacity", sql`${t.capacity} IS NULL OR ${t.issued} <= ${t.capacity}`),
    check("ck_ticket_types_entry_mode", sql`${t.entryMode} IN (${sql.raw(sqlList(ENTRY_MODES))})`),
    check(
      "ck_ticket_types_max_admits",
      sql`(${t.entryMode} = 'limited' AND ${t.maxAdmits} IS NOT NULL AND ${t.maxAdmits} BETWEEN 2 AND 63) OR (${t.entryMode} <> 'limited' AND ${t.maxAdmits} IS NULL)`,
    ),
    check("ck_ticket_types_early_entry", sql`${t.earlyEntryMin} BETWEEN 15 AND 30`),
    check("ck_ticket_types_idx", sql`${t.idx} BETWEEN 0 AND 255`),
  ],
);

export const tickets = mysqlTable(
  "tickets",
  {
    id: ticketIdCol("id").primaryKey(),
    eventId: int("event_id")
      .notNull()
      .references(() => events.id),
    ticketType: smallint("ticket_type").notNull(),
    holderName: varchar("holder_name", { length: 255 }),
    holderEmail: varchar("holder_email", { length: 320 }),
    note: text("note"),
    issuedBy: uuidCol("issued_by").references(() => staff.id),
    tokenNonce: binary(NONCE_BYTES)("token_nonce", { length: NONCE_BYTES }).notNull(),
    entryMode: varchar("entry_mode", { length: 16 }).notNull(),
    /** 1 for single, NULL for unlimited, N for limited. */
    maxAdmits: smallint("max_admits"),
    gateMask: smallint("gate_mask", { unsigned: true }).notNull().default(0),
    slotStart: unixCol("slot_start"),
    slotEnd: unixCol("slot_end"),
    admitsUsed: smallint("admits_used").notNull().default(0),
    inside: boolean("inside").notNull().default(false),
    status: varchar("status", { length: 16 }).notNull().default("valid"),
    issuedAt: unixCol("issued_at").notNull(),
    updatedAt: unixCol("updated_at").notNull(),
    /** When the ticket was cancelled; offline admits scanned after this are conflicts. */
    cancelledAt: unixCol("cancelled_at"),
  },
  (t) => [
    index("ix_tickets_event_updated").on(t.eventId, t.updatedAt, t.id),
    check("ck_tickets_entry_mode", sql`${t.entryMode} IN (${sql.raw(sqlList(ENTRY_MODES))})`),
    check("ck_tickets_status", sql`${t.status} IN (${sql.raw(sqlList(TICKET_STATUSES))})`),
  ],
);

export const devices = mysqlTable(
  "devices",
  {
    id: uuidCol("id").primaryKey(),
    eventId: int("event_id")
      .notNull()
      .references(() => events.id),
    label: varchar("label", { length: 255 }),
    gate: varchar("gate", { length: 255 }).notNull(),
    direction: varchar("direction", { length: 8 }).notNull().default("entry"),
    tokenHash: text("token_hash").notNull(),
    revoked: boolean("revoked").notNull().default(false),
    lastSeenAt: unixCol("last_seen_at"),
    kind: varchar("kind", { length: 8 }).notNull().default("scanner"),
  },
  (t) => [
    check("ck_devices_direction", sql`${t.direction} IN (${sql.raw(sqlList(DEVICE_DIRECTIONS))})`),
    check("ck_devices_kind", sql`${t.kind} IN (${sql.raw(sqlList(DEVICE_KINDS))})`),
  ],
);

export const enrolmentCodes = mysqlTable(
  "enrolment_codes",
  {
    id: int("id").autoincrement().primaryKey(),
    eventId: int("event_id")
      .notNull()
      .references(() => events.id),
    /** SHA-256 hex of the one-time code; the code itself is only in the setup QR. */
    codeHash: char("code_hash", { length: 64 }).notNull(),
    gate: varchar("gate", { length: 255 }).notNull(),
    direction: varchar("direction", { length: 8 }).notNull().default("entry"),
    label: varchar("label", { length: 255 }),
    createdBy: uuidCol("created_by").references(() => staff.id),
    createdAt: unixCol("created_at").notNull(),
    expiresAt: unixCol("expires_at").notNull(),
    usedAt: unixCol("used_at"),
    deviceId: uuidCol("device_id").references(() => devices.id),
    kind: varchar("kind", { length: 8 }).notNull().default("scanner"),
  },
  (t) => [
    uniqueIndex("ux_enrolment_codes_hash").on(t.codeHash),
    check(
      "ck_enrolment_codes_direction",
      sql`${t.direction} IN (${sql.raw(sqlList(DEVICE_DIRECTIONS))})`,
    ),
    check("ck_enrolment_codes_kind", sql`${t.kind} IN (${sql.raw(sqlList(DEVICE_KINDS))})`),
  ],
);

export const scans = mysqlTable(
  "scans",
  {
    /** Generated on the device (UUIDv7) so replaying a sync batch is idempotent. */
    id: uuidCol("id").primaryKey(),
    ticketId: ticketIdCol("ticket_id")
      .notNull()
      .references(() => tickets.id),
    deviceId: uuidCol("device_id").references(() => devices.id),
    staffId: uuidCol("staff_id").references(() => staff.id),
    gate: varchar("gate", { length: 255 }).notNull(),
    direction: varchar("direction", { length: 8 }).notNull(),
    /** Device clock. */
    scannedAt: unixCol("scanned_at").notNull(),
    /** Hub or server clock. */
    receivedAt: unixCol("received_at"),
    result: varchar("result", { length: 24 }).notNull(),
    offline: boolean("offline").notNull(),
    conflict: boolean("conflict").notNull().default(false),
  },
  (t) => [
    index("ix_scans_ticket").on(t.ticketId),
    check("ck_scans_direction", sql`${t.direction} IN (${sql.raw(sqlList(DIRECTIONS))})`),
    check("ck_scans_result", sql`${t.result} IN (${sql.raw(sqlList(SCAN_RESULTS))})`),
  ],
);

export const emailQueue = mysqlTable(
  "email_queue",
  {
    id: int("id").autoincrement().primaryKey(),
    ticketId: ticketIdCol("ticket_id")
      .notNull()
      .references(() => tickets.id),
    toEmail: varchar("to_email", { length: 320 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: tinyint("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: unixCol("next_attempt_at").notNull(),
    createdAt: unixCol("created_at").notNull(),
    sentAt: unixCol("sent_at"),
  },
  (t) => [
    index("ix_email_queue_due").on(t.status, t.nextAttemptAt),
    check("ck_email_queue_status", sql`${t.status} IN (${sql.raw(sqlList(EMAIL_STATUSES))})`),
  ],
);

/** Server-only (the hub never issues tickets): replays of `POST /events/{id}/tickets` return the same tickets. */
export const idempotencyKeys = mysqlTable(
  "idempotency_keys",
  {
    eventId: int("event_id")
      .notNull()
      .references(() => events.id),
    key: varchar("key", { length: 128 }).notNull(),
    /** SHA-256 hex of the canonical request, so reusing a key for a different request is caught. */
    requestHash: char("request_hash", { length: 64 }).notNull(),
    /** Ticket ids (hex) the request created, in order. */
    ticketIds: json("ticket_ids").$type<string[]>().notNull(),
    createdAt: unixCol("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.key] })],
);
