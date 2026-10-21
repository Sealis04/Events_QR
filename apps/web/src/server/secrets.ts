import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
export const fromB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

export const sha256Hex = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** URL-safe random string with `bytes` bytes of entropy. */
export const randomToken = (bytes: number): string => randomBytes(bytes).toString("base64url");

/** Master key from env: 32 bytes as 64 hex characters or base64. */
export function parseMasterKey(text: string): Uint8Array {
  const trimmed = text.trim();
  const raw = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (raw.length !== 32)
    throw new Error("EVENT_KEY_MASTER must be 32 bytes (64 hex chars or base64)");
  return new Uint8Array(raw);
}

const EVENT_KEY_AAD = Buffer.from("events-qr/event-key/v1");

/**
 * Event AES keys are stored in `events.enc_key_ref` as `v1:<nonce>:<ciphertext||tag>` (base64),
 * AES-256-GCM under the master key from env.
 */
export function encryptEventKey(eventKey: Uint8Array, master: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", master, nonce);
  cipher.setAAD(EVENT_KEY_AAD);
  const ct = Buffer.concat([cipher.update(eventKey), cipher.final(), cipher.getAuthTag()]);
  return `v1:${nonce.toString("base64")}:${ct.toString("base64")}`;
}

export function decryptEventKey(ref: string, master: Uint8Array): Uint8Array {
  const [version, nonceB64, ctB64] = ref.split(":");
  if (version !== "v1" || !nonceB64 || !ctB64) throw new Error("unsupported event key format");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv("aes-256-gcm", master, Buffer.from(nonceB64, "base64"));
  decipher.setAAD(EVENT_KEY_AAD);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  return new Uint8Array(
    Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]),
  );
}
