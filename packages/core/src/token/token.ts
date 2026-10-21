import sodium from "libsodium-wrappers";
import { base45Decode, base45Encode } from "../base45";
import { concatBytes, randomBytes } from "../bytes";
import {
  buildPayload,
  parsePayload,
  PAYLOAD_LENGTH,
  PAYLOAD_VERSION,
  type TicketPayload,
} from "./payload";

export const TOKEN_PREFIX = "EVT1:";
const AAD = new TextEncoder().encode("EVT1");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SIG_LENGTH = 64;
const INNER_LENGTH = PAYLOAD_LENGTH + SIG_LENGTH; // 98
/** nonce || ct || tag */
export const TOKEN_BYTES = NONCE_LENGTH + INNER_LENGTH + TAG_LENGTH; // 126

export type VerifyError = "not_ours" | "invalid" | "wrong_event" | "unknown_key";

export type VerifyResult =
  { ok: true; payload: TicketPayload } | { ok: false; error: VerifyError; payload?: TicketPayload };

/** Public Ed25519 keys by `key_id`, so signing keys can rotate. */
export type PublicKeys = ReadonlyMap<number, Uint8Array> | Readonly<Record<number, Uint8Array>>;

export interface Ed25519KeyPair {
  /** 32 bytes. */
  publicKey: Uint8Array;
  /** 64 bytes, libsodium format (seed || public key). */
  privateKey: Uint8Array;
}

export async function generateSigningKeyPair(seed?: Uint8Array): Promise<Ed25519KeyPair> {
  await sodium.ready;
  const kp = seed ? sodium.crypto_sign_seed_keypair(seed) : sodium.crypto_sign_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/** A fresh 32-byte AES-256 event key. */
export function generateEventKey(): Uint8Array {
  return randomBytes(32);
}

async function aesKey(raw: Uint8Array, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
  if (raw.length !== 32) throw new RangeError("event key must be 32 bytes");
  return globalThis.crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, [usage]);
}

/**
 * Sign-then-encrypt. `nonce` is only for deterministic re-send (the stored nonce) and tests;
 * leave it out to get a fresh random one.
 */
export async function mintToken(
  payload: TicketPayload,
  signingKey: Uint8Array,
  eventKey: Uint8Array,
  nonce?: Uint8Array,
): Promise<string> {
  await sodium.ready;
  if (nonce && nonce.length !== NONCE_LENGTH) throw new RangeError("nonce must be 12 bytes");
  const bytes = buildPayload(payload);
  const inner = concatBytes(bytes, sodium.crypto_sign_detached(bytes, signingKey));
  const iv = nonce ?? randomBytes(NONCE_LENGTH);
  const ctAndTag = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as BufferSource,
        additionalData: AAD as BufferSource,
        tagLength: TAG_LENGTH * 8,
      },
      await aesKey(eventKey, "encrypt"),
      inner as BufferSource,
    ),
  );
  return TOKEN_PREFIX + base45Encode(concatBytes(iv, ctAndTag));
}

/**
 * Validation order from the spec: prefix, Base45, AES-GCM, Ed25519, then key_id and event_id.
 * Never throws on bad input; returns a typed error.
 */
export async function verifyToken(
  raw: string,
  publicKeys: PublicKeys,
  eventKey: Uint8Array,
  expectedEventId?: number,
): Promise<VerifyResult> {
  await sodium.ready;
  if (!raw.startsWith(TOKEN_PREFIX)) return { ok: false, error: "not_ours" };

  let bytes: Uint8Array;
  try {
    bytes = base45Decode(raw.slice(TOKEN_PREFIX.length));
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (bytes.length !== TOKEN_BYTES) return { ok: false, error: "invalid" };

  let inner: Uint8Array;
  try {
    inner = new Uint8Array(
      await globalThis.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(0, NONCE_LENGTH) as BufferSource,
          additionalData: AAD as BufferSource,
          tagLength: TAG_LENGTH * 8,
        },
        await aesKey(eventKey, "decrypt"),
        bytes.slice(NONCE_LENGTH) as BufferSource,
      ),
    );
  } catch {
    return { ok: false, error: "invalid" }; // wrong event key, or tampered
  }

  const payloadBytes = inner.slice(0, PAYLOAD_LENGTH);
  const signature = inner.slice(PAYLOAD_LENGTH);
  const payload = parsePayload(payloadBytes);
  if (payload.version !== PAYLOAD_VERSION) return { ok: false, error: "invalid" };

  const publicKey =
    publicKeys instanceof Map
      ? publicKeys.get(payload.keyId)
      : (publicKeys as Record<number, Uint8Array>)[payload.keyId];
  if (!publicKey) return { ok: false, error: "unknown_key" };
  if (!sodium.crypto_sign_verify_detached(signature, payloadBytes, publicKey)) {
    return { ok: false, error: "invalid" };
  }
  if (expectedEventId !== undefined && payload.eventId !== expectedEventId) {
    return { ok: false, error: "wrong_event", payload };
  }
  return { ok: true, payload };
}
