import { bytesToHex } from "../bytes";

/** Inner payload, 34 bytes, big-endian. Layout follows docs/spec.md "Ticket token format". */
export const PAYLOAD_VERSION = 0x01;
export const PAYLOAD_LENGTH = 34;

export interface TicketPayload {
  version: number;
  eventId: number;
  /** 16 random bytes. */
  ticketId: Uint8Array;
  ticketType: number;
  /** Unix seconds UTC. */
  issuedAt: number;
  keyId: number;
  /** Encoded with `encodeEntryRule`. */
  entryRule: number;
  gateMask: number;
  slotStart: number;
  slotEnd: number;
}

function assertInt(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max)
    throw new RangeError(`${name} out of range`);
}

export function buildPayload(p: TicketPayload): Uint8Array {
  if (p.ticketId.length !== 16) throw new RangeError("ticketId must be 16 bytes");
  assertInt("version", p.version, 0xff);
  assertInt("eventId", p.eventId, 0xffffffff);
  assertInt("ticketType", p.ticketType, 0xff);
  assertInt("issuedAt", p.issuedAt, 0xffffffff);
  assertInt("keyId", p.keyId, 0xff);
  assertInt("entryRule", p.entryRule, 0xff);
  assertInt("gateMask", p.gateMask, 0xffff);
  assertInt("slotStart", p.slotStart, 0xffff);
  assertInt("slotEnd", p.slotEnd, 0xffff);

  const out = new Uint8Array(PAYLOAD_LENGTH);
  const view = new DataView(out.buffer);
  view.setUint8(0, p.version);
  view.setUint32(1, p.eventId);
  out.set(p.ticketId, 5);
  view.setUint8(21, p.ticketType);
  view.setUint32(22, p.issuedAt);
  view.setUint8(26, p.keyId);
  view.setUint8(27, p.entryRule);
  view.setUint16(28, p.gateMask);
  view.setUint16(30, p.slotStart);
  view.setUint16(32, p.slotEnd);
  return out;
}

export function parsePayload(bytes: Uint8Array): TicketPayload {
  if (bytes.length !== PAYLOAD_LENGTH) throw new RangeError("payload must be 34 bytes");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version: view.getUint8(0),
    eventId: view.getUint32(1),
    ticketId: bytes.slice(5, 21),
    ticketType: view.getUint8(21),
    issuedAt: view.getUint32(22),
    keyId: view.getUint8(26),
    entryRule: view.getUint8(27),
    gateMask: view.getUint16(28),
    slotStart: view.getUint16(30),
    slotEnd: view.getUint16(32),
  };
}

/** Hex of the ticket id, the primary key of the ticket. */
export function ticketIdHex(p: Pick<TicketPayload, "ticketId">): string {
  return bytesToHex(p.ticketId);
}

/** Last 6 hex characters, printed under the QR for manual search. */
export function shortTicketId(p: Pick<TicketPayload, "ticketId">): string {
  return ticketIdHex(p).slice(-6);
}
