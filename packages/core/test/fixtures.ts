import { encodeEntryRule, generateSigningKeyPair, type TicketPayload } from "../src";

/** Deterministic inputs for the known-answer vector. Never use these outside tests. */
export const SEED = new Uint8Array(32).map((_, i) => i + 1);
export const EVENT_KEY = new Uint8Array(32).map((_, i) => 0xa0 + i);
export const NONCE = new Uint8Array(12).map((_, i) => 0x10 + i);
export const EVENT_ID = 4242;

export function samplePayload(overrides: Partial<TicketPayload> = {}): TicketPayload {
  return {
    version: 1,
    eventId: EVENT_ID,
    ticketId: new Uint8Array(16).map((_, i) => 0xf0 - i),
    ticketType: 2,
    issuedAt: 1_800_000_000,
    keyId: 1,
    entryRule: encodeEntryRule("limited", 3),
    gateMask: 0b101,
    slotStart: 0xffff,
    slotEnd: 0xffff,
    ...overrides,
  };
}

export async function sampleKeys() {
  const kp = await generateSigningKeyPair(SEED);
  return { ...kp, publicKeys: new Map([[1, kp.publicKey]]) };
}
