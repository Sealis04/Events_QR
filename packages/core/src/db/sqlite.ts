import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  DEVICE_DIRECTIONS,
  DEVICE_KINDS,
  DIRECTIONS,
  EMAIL_STATUSES,
  ENTRY_MODES,
  HUB_CHECK_RESULTS,
  HUB_CHECK_SOURCES,
  HUB_CHECK_STEPS,
  SCAN_RESULTS,
  STAFF_ROLES,
  TICKET_STATUSES,
  sqlList,
} from "./shared";

const blob = (name: string) =>
  customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "blob" })(name);
const ticketIdCol = (name: string) => blob(name);
const unixCol = (name: string) => integer(name, { mode: "number" });
const bool = (name: string) => integer(name, { mode: "boolean" });

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  startsAt: unixCol("starts_at").notNull(),
  endsAt: unixCol("ends_at").notNull(),
  encKeyRef: text("enc_key_ref").notNull(),
  signKeyId: integer("sign_key_id").notNull(),
  gates: text("gates", { mode: "json" }).$type<string[]>().notNull(),
  config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
});

export const staff = sqliteTable(
  "staff",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    pinHash: text("pin_hash").notNull(),
    role: text("role").notNull(),
    pinReset: text("pin_reset"),
  },
  (t) => [
    check("ck_staff_pin_reset", sql`${t.pinReset} IS NULL OR ${t.pinReset} IN ('weak', 'rotate')`),
    check("ck_staff_role", sql`${t.role} IN (${sql.raw(sqlList(STAFF_ROLES))})`),
  ],
);

export const eventStaff = sqliteTable(
  "event_staff",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    staffId: text("staff_id")
      .notNull()
      .references(() => staff.id),
    assigned: bool("assigned").notNull(),
  },
  (t) => [primaryKey({ columns: [t.eventId, t.staffId] })],
);

export const ticketTypes = sqliteTable(
  "ticket_types",
  {
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    idx: integer("idx").notNull(),
    name: text("name").notNull(),
    capacity: integer("capacity"),
    issued: integer("issued").notNull().default(0),
    entryMode: text("entry_mode").notNull().default("single"),
    maxAdmits: integer("max_admits"),
    gateMask: integer("gate_mask").notNull().default(0),
    slots: text("slots", { mode: "json" }).$type<{ start: number; end: number }[]>(),
    earlyEntryMin: integer("early_entry_min").notNull().default(15),
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

export const tickets = sqliteTable(
  "tickets",
  {
    id: ticketIdCol("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    ticketType: integer("ticket_type").notNull(),
    holderName: text("holder_name"),
    holderEmail: text("holder_email"),
    note: text("note"),
    holderPhone: text("holder_phone"),
    issuedBy: text("issued_by").references(() => staff.id),
    tokenNonce: blob("token_nonce").notNull(),
    entryMode: text("entry_mode").notNull(),
    maxAdmits: integer("max_admits"),
    gateMask: integer("gate_mask").notNull().default(0),
    slotStart: unixCol("slot_start"),
    slotEnd: unixCol("slot_end"),
    admitsUsed: integer("admits_used").notNull().default(0),
    inside: bool("inside").notNull().default(false),
    status: text("status").notNull().default("valid"),
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

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    label: text("label"),
    gate: text("gate").notNull(),
    direction: text("direction").notNull().default("entry"),
    tokenHash: text("token_hash").notNull(),
    revoked: bool("revoked").notNull().default(false),
    lastSeenAt: unixCol("last_seen_at"),
    kind: text("kind").notNull().default("scanner"),
    batteryPct: integer("battery_pct"),
    outboxSize: integer("outbox_size"),
    reportedAt: unixCol("reported_at"),
    lastPullAt: unixCol("last_pull_at"),
  },
  (t) => [
    check("ck_devices_direction", sql`${t.direction} IN (${sql.raw(sqlList(DEVICE_DIRECTIONS))})`),
    check("ck_devices_kind", sql`${t.kind} IN (${sql.raw(sqlList(DEVICE_KINDS))})`),
  ],
);

export const enrolmentCodes = sqliteTable(
  "enrolment_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    codeHash: text("code_hash").notNull(),
    gate: text("gate").notNull(),
    direction: text("direction").notNull().default("entry"),
    label: text("label"),
    createdBy: text("created_by").references(() => staff.id),
    createdAt: unixCol("created_at").notNull(),
    expiresAt: unixCol("expires_at").notNull(),
    usedAt: unixCol("used_at"),
    deviceId: text("device_id").references(() => devices.id),
    kind: text("kind").notNull().default("scanner"),
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

export const scans = sqliteTable(
  "scans",
  {
    id: text("id").primaryKey(),
    ticketId: ticketIdCol("ticket_id")
      .notNull()
      .references(() => tickets.id),
    deviceId: text("device_id").references(() => devices.id),
    staffId: text("staff_id").references(() => staff.id),
    gate: text("gate").notNull(),
    direction: text("direction").notNull(),
    scannedAt: unixCol("scanned_at").notNull(),
    receivedAt: unixCol("received_at"),
    result: text("result").notNull(),
    offline: bool("offline").notNull(),
    conflict: bool("conflict").notNull().default(false),
    reviewedAt: unixCol("reviewed_at"),
    reviewedBy: text("reviewed_by"),
  },
  (t) => [
    index("ix_scans_ticket").on(t.ticketId),
    check("ck_scans_direction", sql`${t.direction} IN (${sql.raw(sqlList(DIRECTIONS))})`),
    check("ck_scans_result", sql`${t.result} IN (${sql.raw(sqlList(SCAN_RESULTS))})`),
  ],
);

export const emailQueue = sqliteTable(
  "email_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ticketId: ticketIdCol("ticket_id")
      .notNull()
      .references(() => tickets.id),
    toEmail: text("to_email").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
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

/**
 * Hub-only bookkeeping (not in the MariaDB schema): the hub's own credential, its sync cursors,
 * and what has not yet reached the VM. Scan rows pulled from the VM never enter the scan outbox.
 */
export const hubState = sqliteTable("hub_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Scans the hub produced (claims, exits, uploads from phones) and whether the VM acknowledged them. */
export const hubScanOutbox = sqliteTable(
  "hub_scan_outbox",
  {
    scanId: text("scan_id").primaryKey(),
    ackedAt: unixCol("acked_at"),
  },
  (t) => [index("ix_hub_scan_outbox_pending").on(t.ackedAt)],
);

/** Devices enrolled at the hub that the VM has not seen yet, with the one-time code they used. */
export const hubDeviceOutbox = sqliteTable("hub_device_outbox", {
  deviceId: text("device_id").primaryKey(),
  codeHash: text("code_hash").notNull(),
  usedAt: unixCol("used_at").notNull(),
  ackedAt: unixCol("acked_at"),
});

/** Hub setup checklist results (M12); same shape as the MariaDB table, see db/mysql.ts. */
export const hubChecks = sqliteTable(
  "hub_checks",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    eventId: integer("event_id")
      .notNull()
      .references(() => events.id),
    deviceId: text("device_id"),
    step: text("step").notNull(),
    result: text("result").notNull(),
    code: text("code"),
    summary: text("summary").notNull(),
    details: text("details", { mode: "json" }).$type<
      Record<string, string | number | boolean | null>
    >(),
    checkedAt: unixCol("checked_at").notNull(),
    checkedBy: text("checked_by"),
    checkedByName: text("checked_by_name"),
    source: text("source").notNull(),
  },
  (t) => [
    uniqueIndex("ux_hub_checks_id").on(t.id),
    index("ix_hub_checks_event_step").on(t.eventId, t.step, t.checkedAt),
    check("ck_hub_checks_step", sql`${t.step} IN (${sql.raw(sqlList(HUB_CHECK_STEPS))})`),
    check("ck_hub_checks_result", sql`${t.result} IN (${sql.raw(sqlList(HUB_CHECK_RESULTS))})`),
    check("ck_hub_checks_source", sql`${t.source} IN (${sql.raw(sqlList(HUB_CHECK_SOURCES))})`),
  ],
);

/** Hub checks made on the hub that the VM has not acknowledged yet. */
export const hubCheckOutbox = sqliteTable("hub_check_outbox", {
  checkId: text("check_id").primaryKey(),
  ackedAt: unixCol("acked_at"),
});
