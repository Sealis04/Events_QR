import { z } from "zod";
import { DEVICE_DIRECTIONS, ENTRY_MODES, STAFF_ROLES } from "../db/shared";
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
  scanCursor,
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
    /** Offline devices admit only tickets whose signed gate list names their gate. */
    offline_gate_only: z.boolean(),
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
  /** A phone only wants the yes/no: someone who must change their PIN is refused instead of getting a restricted session. */
  for: z.literal("scanner").optional(),
});
/** `POST /auth/change-pin` (any logged-in staff, also while a PIN change is required). */
export const changePinRequest = z.object({
  current_pin: z.string().min(1).max(128),
  new_pin: z.string().min(1).max(128),
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
  holder_phone: z.string().min(3).max(64).optional(),
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
  /**
   * Codes for the venue hub: valid until the event's `ends_at` instead of 10 minutes, still single
   * use, cached (hashed) by the hub so phones can enrol with no internet. `count` makes a batch.
   */
  for_hub: z.boolean().optional(),
  count: z.number().int().min(1).max(50).optional(),
});
export const createSetupResponse = z.object({
  /** The `DEV1:` text to render as a QR (the first one of a batch). */
  setup_qr: z.string().startsWith("DEV1:"),
  /** Every code of the batch, in order. Codes are stored hashed: this is the only time they show. */
  setup_qrs: z.array(z.string().startsWith("DEV1:")).min(1),
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

/** `POST /hubs/setup` (supervisor): a one-time code that binds one hub to one event. */
export const hubSetupRequest = z.object({
  event_id: z.number().int(),
  label: z.string().max(255).optional(),
});
export const hubSetupResponse = z.object({
  /** Typed into `scripts/hub-enroll.ts` on the hub. */
  setup_code: z.string().min(1),
  expires_at: unixSeconds,
});

/** `GET /sync/meta` (hub): everything small that the hub mirrors, in one snapshot. */
export const syncMetaResponse = z.object({
  event: z.object({
    id: z.number().int(),
    name: z.string(),
    starts_at: unixSeconds,
    ends_at: unixSeconds,
    sign_key_id: z.number().int(),
    gates: z.array(gateName),
    config: z.record(z.unknown()).nullable(),
  }),
  ticket_types: z.array(
    z.object({
      idx: z.number().int().min(0).max(255),
      name: z.string(),
      capacity: z.number().int().nullable(),
      issued: z.number().int(),
      entry_mode: z.enum(ENTRY_MODES),
      max_admits: z.number().int().nullable(),
      gate_mask: gateMask,
      slots: z.array(z.object({ start: z.number().int(), end: z.number().int() })).nullable(),
      early_entry_min: z.number().int(),
    }),
  ),
  /** All staff, with PIN hashes, so phones can log in at the hub with no internet. */
  staff: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      pin_hash: z.string(),
      role: z.enum(STAFF_ROLES),
    }),
  ),
  /** Scanner devices of the event (token hashes included), revoked ones too. */
  devices: z.array(
    z.object({
      id: uuid,
      gate: gateName,
      direction: z.enum(DEVICE_DIRECTIONS),
      label: z.string().nullable(),
      token_hash: z.string(),
      revoked: z.boolean(),
    }),
  ),
  /** Phone enrolment codes that are neither used nor expired. */
  enrolment_codes: z.array(
    z.object({
      code_hash: z.string().length(64),
      gate: gateName,
      direction: z.enum(DEVICE_DIRECTIONS),
      label: z.string().nullable(),
      expires_at: unixSeconds,
    }),
  ),
  server_time: unixSeconds,
});

/** `GET /sync/scans?cursor=` (hub): scans the VM holds, so the hub converges on the same state. */
export const syncVmScansQuery = z.object({
  cursor: scanCursor.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export const syncVmScansResponse = z.object({
  scans: z.array(scanRecord.extend({ received_at: unixSeconds.nullable() })),
  next_cursor: scanCursor.nullable(),
  has_more: z.boolean(),
});

/** `POST /sync/devices` (hub): phones enrolled at the hub, so their tokens work on the VM too. */
export const syncDevicesRequest = z.object({
  devices: z
    .array(
      z.object({
        id: uuid,
        gate: gateName,
        direction: z.enum(DEVICE_DIRECTIONS),
        label: z.string().nullable(),
        token_hash: z.string().length(64),
        code_hash: z.string().length(64),
        enrolled_at: unixSeconds,
      }),
    )
    .min(1)
    .max(200),
});
export const syncDevicesResponse = z.object({ acknowledged: z.array(uuid) });

/** `GET /events/{id}/stats` (dashboard). */
export const eventStatsResponse = z.object({
  total_admitted: z.number().int(),
  inside: z.number().int(),
  by_gate: z.record(gateName, z.number().int()),
  by_ticket_type: z.record(z.string().regex(/^\d+$/), z.number().int()),
  conflicts: z.number().int(),
  scans_per_minute: z.array(z.object({ minute: unixSeconds, count: z.number().int() })),
  /** Tickets used at least once that are outside again (not cancelled). */
  left: z.number().int().optional(),
  /** Entries in the last 60 seconds. */
  last_minute: z.number().int().optional(),
  /** The busiest single minute of the event so far. */
  busiest: z.object({ minute: unixSeconds, count: z.number().int() }).nullable().optional(),
  /** Conflicts nobody has marked as reviewed yet. */
  open_conflicts: z.number().int().optional(),
  /** Hub only: whether the VM answered at the last sync. */
  hub: z
    .object({
      online: z.boolean(),
      last_sync_at: unixSeconds.nullable(),
      last_error: z.string().nullable(),
    })
    .optional(),
});

export { keyBundle };

/** `GET /events/{id}/conflicts` (supervisor): scans flagged `conflict`, newest first (M6's feed). */
export const conflictsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().nonnegative().optional(),
});
export const conflictsResponse = z.object({
  conflicts: z.array(
    z.object({
      scan_id: uuid,
      ticket_id: ticketIdHex,
      holder_name: z.string().nullable(),
      gate: gateName,
      device_id: uuid.nullable(),
      scanned_at: unixSeconds,
      received_at: unixSeconds.nullable(),
      offline: z.boolean(),
      /** The earlier admit that stays canonical, or null when the ticket was cancelled first. */
      canonical: z.object({ gate: gateName, scanned_at: unixSeconds }).nullable(),
      ticket_status: ticketStatus,
      /** Both scans side by side (M6): who scanned, on which device. */
      staff_id: uuid.nullable().optional(),
      staff_name: z.string().nullable().optional(),
      device_label: z.string().nullable().optional(),
      canonical_detail: z
        .object({
          gate: gateName,
          scanned_at: unixSeconds,
          offline: z.boolean(),
          device_id: uuid.nullable(),
          device_label: z.string().nullable(),
          staff_name: z.string().nullable(),
        })
        .nullable()
        .optional(),
      reviewed_at: unixSeconds.nullable().optional(),
    }),
  ),
  total: z.number().int(),
});

/** `GET /events/{id}/staff` (admin) and `PUT /events/{id}/staff/{staffId}`: who works this event. */
export const eventStaffResponse = z.object({
  staff: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      role: z.enum(STAFF_ROLES),
      assignment: z.enum(["issued", "added", "removed"]).nullable(),
      /** PIN hashes of assigned staff are on the event's phones and hub. */
      assigned: z.boolean(),
      pin_reset: z.enum(["weak", "rotate"]).nullable(),
    }),
  ),
});
/** `true` adds, `false` removes (their hash leaves the phones at the next sync), `null` restores the default. */
export const setEventStaffRequest = z.object({ assigned: z.boolean().nullable() });

/** `POST /devices/heartbeat` (device): what the phone knows about itself. */
export const heartbeatRequest = z.object({
  outbox_size: z.number().int().min(0).max(1_000_000),
  /** 0-100 from the Battery API, or null where the browser has none. */
  battery_pct: z.number().int().min(0).max(100).nullable().optional(),
});

/** `GET /events/{id}/devices` (supervisor). */
export const devicePanelResponse = z.object({
  devices: z.array(
    z.object({
      id: uuid,
      kind: z.enum(["scanner", "hub"]),
      label: z.string().nullable(),
      gate: gateName,
      direction: deviceDirection,
      revoked: z.boolean(),
      last_seen_at: unixSeconds.nullable(),
      outbox_size: z.number().int().nullable(),
      battery_pct: z.number().int().nullable(),
      last_scan_at: unixSeconds.nullable(),
    }),
  ),
  server_time: unixSeconds,
});
/** `PATCH /devices/{id}` (supervisor): move a phone to another gate or role. */
export const updateDeviceRequest = z
  .object({ gate: gateName, direction: deviceDirection, label: z.string().max(255).nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });
/** `POST /devices/{id}/revoke` (supervisor). `rotate` also forces a PIN change for staff whose hashes it may hold. */
export const revokeDeviceRequest = z.object({ rotate: z.boolean().optional() });
export const revokeDeviceResponse = z.object({
  revoked: z.literal(true),
  rotated_staff: z.array(z.object({ id: uuid, name: z.string() })),
});

/** `POST /scans/{id}/review` (supervisor): mark a conflict as looked at. */
export const reviewConflictRequest = z.object({ reviewed: z.boolean().default(true) });

/** `POST /events/{id}/admit` (supervisor): manual admit from attendee search; the PIN is re-checked. */
export const manualAdmitRequest = z.object({
  ticket_id: ticketIdHex,
  pin: z.string().min(1).max(128),
});
export const manualAdmitResponse = z.object({
  result: z.enum(["admitted", "rejected_used", "rejected_inside", "rejected_cancelled"]),
  admits_used: z.number().int().min(0).optional(),
});

/** `GET /events/{id}/overrides` (supervisor): manual admits and overrides by staff. */
export const overridesResponse = z.object({
  overrides: z.array(
    z.object({
      scan_id: uuid,
      ticket_id: ticketIdHex,
      holder_name: z.string().nullable(),
      staff_id: uuid.nullable(),
      staff_name: z.string().nullable(),
      gate: gateName,
      device_id: uuid.nullable(),
      scanned_at: unixSeconds,
      offline: z.boolean(),
    }),
  ),
  by_staff: z.array(
    z.object({
      staff_id: uuid.nullable(),
      staff_name: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});
