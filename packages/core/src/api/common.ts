import { z } from "zod";
import {
  DEVICE_DIRECTIONS,
  DIRECTIONS,
  ENTRY_MODES,
  SCAN_RESULTS,
  TICKET_STATUSES,
} from "../db/shared";

/** JSON on the wire is snake_case, as in docs/spec.md. Binary ids travel as lowercase hex. */
export const uuid = z.string().uuid();
export const ticketIdHex = z.string().regex(/^[0-9a-f]{32}$/, "32 lowercase hex characters");
export const unixSeconds = z.number().int().nonnegative();
export const gateName = z.string().min(1).max(255);
export const entryMode = z.enum(ENTRY_MODES);
export const ticketStatus = z.enum(TICKET_STATUSES);
export const scanDirection = z.enum(DIRECTIONS);
export const deviceDirection = z.enum(DEVICE_DIRECTIONS);
export const scanResult = z.enum(SCAN_RESULTS);
export const token = z.string().startsWith("EVT1:");
export const gateMask = z.number().int().min(0).max(0xffff);
export const slotMinute = z.number().int().min(0).max(0xffff);

export const entryRule = z
  .object({ mode: entryMode, max_admits: z.number().int().min(2).max(63).nullable().optional() })
  .refine((r) => (r.mode === "limited" ? r.max_admits != null : r.max_admits == null), {
    message: "max_admits is required for limited and not allowed otherwise",
  });

/** A ticket as the hub and scanners hold it. */
export const syncTicket = z.object({
  id: ticketIdHex,
  event_id: z.number().int(),
  ticket_type: z.number().int().min(0).max(255),
  holder_name: z.string().nullable(),
  entry_mode: entryMode,
  max_admits: z.number().int().nullable(),
  gate_mask: gateMask,
  slot_start: unixSeconds.nullable(),
  slot_end: unixSeconds.nullable(),
  admits_used: z.number().int().min(0),
  inside: z.boolean(),
  status: ticketStatus,
  updated_at: unixSeconds,
});
export type SyncTicket = z.infer<typeof syncTicket>;

/** `(updated_at, id)` cursor, encoded `<updated_at>:<ticket id hex>`. Empty/absent = from the start. */
export const cursor = z.string().regex(/^\d+:[0-9a-f]{32}$/);

export const scanRecord = z.object({
  scan_id: uuid,
  ticket_id: ticketIdHex,
  device_id: uuid,
  staff_id: uuid.nullable().optional(),
  gate: gateName,
  direction: scanDirection,
  scanned_at: unixSeconds,
  result: scanResult,
  offline: z.boolean(),
});
export type ScanRecord = z.infer<typeof scanRecord>;

/** `(received_at, id)` cursor over scans, encoded `<received_at>:<scan uuid>`. */
export const scanCursor = z.string().regex(/^\d+:[0-9a-f-]{36}$/);

export const firstScan = z.object({ gate: gateName, at: unixSeconds, device: uuid.nullable() });

/** What a scanner needs to know about a ticket type besides what is signed into the QR. */
export const scannerTicketType = z.object({
  idx: z.number().int().min(0).max(255),
  name: z.string(),
  /** Minutes before `slot_start` that entry is allowed. */
  early_entry_min: z.number().int().min(0).max(120),
});

export const keyBundle = z.object({
  event_id: z.number().int(),
  /** Base64 of the 32-byte AES-256 event key. */
  event_key: z.string().min(1),
  /** Ed25519 public keys by key_id; value is base64. */
  public_keys: z.record(z.string().regex(/^\d+$/), z.string().min(1)),
  gates: z.array(gateName).min(1).max(16),
  starts_at: unixSeconds,
  ends_at: unixSeconds,
  /** Unix seconds of 00:00 local on the event's first day; the origin for slot minutes. */
  day_zero: unixSeconds,
  ticket_types: z.array(scannerTicketType).default([]),
  /** Base URL of the VM, so a phone that enrolled at the hub still knows where to fall back to. */
  cloud_url: z.string().url().optional(),
});
