import { z } from "zod";
import { STAFF_ROLES } from "../db/shared";
import {
  cursor,
  deviceDirection,
  entryRule,
  gateMask,
  gateName,
  keyBundle,
  scanRecord,
  slotMinute,
  syncTicket,
  ticketIdHex,
  ticketStatus,
  token,
  unixSeconds,
  uuid,
} from "./common";
import { enrollExchangeRequest, enrollExchangeResponse } from "./hub";

export const ticketTypeInput = z.object({
  idx: z.number().int().min(0).max(255),
  name: z.string().min(1).max(255),
  capacity: z.number().int().positive().nullable().optional(),
  entry_rule: entryRule.optional(),
  gate_mask: gateMask.optional(),
  slots: z.array(z.object({ start: slotMinute, end: slotMinute })).optional(),
  early_entry_min: z.number().int().min(15).max(30).optional(),
});

/** `POST /events` (admin). */
export const createEventRequest = z.object({
  name: z.string().min(1).max(255),
  venue: z.string().max(255).optional(),
  /** IANA zone for "00:00 local on the first day" (slot minutes). Defaults to the server's. */
  timezone: z.string().min(1).max(64).optional(),
  starts_at: unixSeconds,
  ends_at: unixSeconds,
  gates: z.array(gateName).min(1).max(16),
  ticket_types: z.array(ticketTypeInput).min(1),
});
export const createEventResponse = z.object({
  id: z.number().int(),
  sign_key_id: z.number().int(),
});

/** `PATCH /events/{id}` (admin). Gates are append-only once tickets exist. */
export const updateEventRequest = z
  .object({
    name: z.string().min(1).max(255),
    venue: z.string().max(255).nullable(),
    starts_at: unixSeconds,
    ends_at: unixSeconds,
    gates: z.array(gateName).min(1).max(16),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

/** `POST /events/{id}/ticket-types` (admin); `idx` defaults to the next free one. */
export const addTicketTypeRequest = ticketTypeInput.partial({ idx: true });
/** `PATCH /events/{id}/ticket-types/{idx}` (admin). Only affects tickets issued from now on. */
export const updateTicketTypeRequest = ticketTypeInput
  .omit({ idx: true })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });

/** `POST /auth/login`. */
export const loginRequest = z.object({
  name: z.string().min(1).max(255),
  pin: z.string().min(1).max(128),
});
/** `POST /staff` (admin). */
export const createStaffRequest = z.object({
  name: z.string().min(1).max(255),
  pin: z.string().min(6).max(128),
  role: z.enum(STAFF_ROLES),
});

/** `POST /events/{id}/tickets` (staff, generator). Idempotency key required. */
export const createTicketsRequest = z.object({
  idempotency_key: z.string().min(8).max(128),
  ticket_type: z.number().int().min(0).max(255),
  quantity: z.number().int().min(1).max(500).default(1),
  holder_name: z.string().min(1).max(255).optional(),
  holder_email: z.string().email().optional(),
  gate_mask: gateMask.optional(),
  slot: z.object({ start: slotMinute, end: slotMinute }).optional(),
  entry_rule: entryRule.optional(),
  note: z.string().max(1000).optional(),
});
export const createTicketsResponse = z.object({
  tickets: z.array(
    z.object({
      ticket_id: ticketIdHex,
      holder_name: z.string().nullable(),
      ticket_type: z.number().int(),
      /** Last 6 hex characters of the ticket id, printed under the QR. */
      short_id: z.string().length(6),
      token,
      /** PNG data URL, level M, at least 300 px with a 4-module quiet zone. */
      qr_png: z.string().startsWith("data:image/png;base64,"),
      qr_svg: z.string().startsWith("<svg").or(z.string().startsWith("<?xml")),
    }),
  ),
});

/** `POST /tickets/{id}/transfer` (admin): cancels the ticket and issues a new one to someone else. */
export const transferTicketRequest = z.object({
  holder_name: z.string().min(1).max(255),
  holder_email: z.string().email().optional(),
});
export const transferTicketResponse = z.object({
  cancelled_ticket_id: ticketIdHex,
  ticket: createTicketsResponse.shape.tickets.element,
});

/** `POST /events/{id}/tickets/import` (admin): CSV text in `csv`, one ticket per row. */
export const importTicketsRequest = z.object({
  csv: z.string().min(1).max(5_000_000),
  /** Re-sending the same key does not issue the rows twice. */
  idempotency_key: z.string().min(8).max(100).optional(),
});
export const importTicketsResponse = z.object({
  created: z.number().int(),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })),
});

/** `POST /tickets/{id}/cancel` (admin). */
export const cancelTicketRequest = z.object({ reason: z.string().max(500).optional() });
export const cancelTicketResponse = z.object({
  ticket_id: ticketIdHex,
  status: ticketStatus,
  updated_at: unixSeconds,
});

/** `POST /tickets/{id}/resend` (admin, attendee self-service). */
export const resendTicketRequest = z.object({ email: z.string().email().optional() });
export const resendTicketResponse = z.object({
  queued: z.literal(true),
  email_queue_id: z.number().int(),
});

/** `POST /devices/enroll`, step 1: a supervisor creates a setup QR. */
export const createSetupRequest = z.object({
  event_id: z.number().int(),
  gate: gateName,
  direction: deviceDirection,
  label: z.string().max(255).optional(),
});
export const createSetupResponse = z.object({
  /** The `DEV1:` text to render as a QR. */
  setup_qr: z.string().startsWith("DEV1:"),
  expires_at: unixSeconds,
});

/** `POST /devices/enroll`, step 2: a device exchanges the one-time code. Same shape as the hub's `/enroll`. */
export { enrollExchangeRequest, enrollExchangeResponse };

/** `GET /sync/tickets?cursor=` (hub). */
export const syncTicketsQuery = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const syncTicketsResponse = z.object({
  tickets: z.array(syncTicket),
  next_cursor: cursor.nullable(),
  has_more: z.boolean(),
});

/** `POST /sync/scans` (hub): batches of up to 500; replays are idempotent on `scan_id`. */
export const syncScansRequest = z.object({ scans: z.array(scanRecord).min(1).max(500) });
export const syncScansResponse = z.object({
  acknowledged: z.array(uuid),
  conflicts: z.array(uuid),
});

/** `GET /events/{id}/stats` (dashboard). */
export const eventStatsResponse = z.object({
  total_admitted: z.number().int(),
  inside: z.number().int(),
  by_gate: z.record(gateName, z.number().int()),
  by_ticket_type: z.record(z.string().regex(/^\d+$/), z.number().int()),
  conflicts: z.number().int(),
  scans_per_minute: z.array(z.object({ minute: unixSeconds, count: z.number().int() })),
});

export { keyBundle };
