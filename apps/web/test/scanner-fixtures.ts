/** Shared builders for the phone-side (offline) tests: signed tickets and a device record. */
import {
  bytesToHex,
  encodeEntryRule,
  generateEventKey,
  generateSigningKeyPair,
  mintToken,
  type EntryMode,
  type TicketPayload,
} from "@events-qr/core";
import type { DeviceRecord, SyncTicket } from "../src/scanner/types";

export const EVENT_ID = 77;
export const DAY_ZERO = 1_900_000_000;
export const NOW = DAY_ZERO + 12 * 3600;
export const GATES = ["Gate A", "Gate B", "VIP door"];
export const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
export const STAFF = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Sam",
  role: "staff",
} as const;
export const SUPERVISOR = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Pat",
  role: "supervisor",
} as const;

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export interface Fixtures {
  eventKey: Uint8Array;
  pair: Awaited<ReturnType<typeof generateSigningKeyPair>>;
  make(opts?: MakeOptions): Promise<Made>;
  device(over?: Partial<DeviceRecord>): DeviceRecord;
}

export interface MakeOptions {
  mode?: EntryMode;
  max?: number;
  gateMask?: number;
  slot?: [number, number];
  name?: string | null;
  status?: SyncTicket["status"];
  /** Fill byte for the 16-byte ticket id; defaults to a counter. */
  idByte?: number;
  /** 4 bytes written at the start of the id (more tickets than one byte can number). */
  idNumber?: number;
}
export interface Made {
  id: string;
  token: string;
  ticket: SyncTicket;
}

export async function createFixtures(): Promise<Fixtures> {
  const eventKey = generateEventKey();
  const pair = await generateSigningKeyPair();
  let n = 0;
  return {
    eventKey,
    pair,
    async make(opts = {}) {
      const id = new Uint8Array(16).fill(opts.idByte ?? (++n % 250) + 1);
      if (opts.idNumber !== undefined) new DataView(id.buffer).setUint32(0, opts.idNumber);
      const payload: TicketPayload = {
        version: 1,
        eventId: EVENT_ID,
        ticketId: id,
        ticketType: 0,
        issuedAt: DAY_ZERO,
        keyId: 1,
        entryRule: encodeEntryRule(opts.mode ?? "single", opts.max),
        gateMask: opts.gateMask ?? 0,
        slotStart: opts.slot?.[0] ?? 0xffff,
        slotEnd: opts.slot?.[1] ?? 0xffff,
      };
      const token = await mintToken(payload, pair.privateKey, eventKey);
      const mode = opts.mode ?? "single";
      const ticket: SyncTicket = {
        id: bytesToHex(id),
        event_id: EVENT_ID,
        ticket_type: 0,
        holder_name: opts.name === undefined ? `Holder ${n}` : opts.name,
        entry_mode: mode,
        max_admits: mode === "limited" ? (opts.max ?? null) : mode === "unlimited" ? null : 1,
        gate_mask: payload.gateMask,
        slot_start: null,
        slot_end: null,
        admits_used: 0,
        inside: false,
        status: opts.status ?? "valid",
        updated_at: 1,
      };
      return { id: ticket.id, token, ticket };
    },
    device(over = {}) {
      return {
        deviceId: DEVICE_ID,
        token: `${DEVICE_ID}.secret`,
        serverUrl: "http://vm.test",
        hubUrl: "http://hub.test",
        cloudUrl: "http://vm.test",
        gate: "Gate A",
        direction: "both",
        label: null,
        clockOffset: 0,
        cursor: null,
        cloudCursor: null,
        synced: true,
        ticketTypes: [{ idx: 0, name: "GA", early_entry_min: 15 }],
        bundle: {
          event_id: EVENT_ID,
          event_key: b64(eventKey),
          public_keys: { "1": b64(pair.publicKey) },
          gates: GATES,
          starts_at: DAY_ZERO,
          ends_at: DAY_ZERO + 86400,
          day_zero: DAY_ZERO,
          ticket_types: [],
        },
        ...over,
      };
    },
  };
}
