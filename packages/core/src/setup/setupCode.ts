import { base45Decode, base45Encode } from "../base45";

/**
 * Setup QR for a phone: `DEV1:` + Base45 of a binary body. Carries no keys or ticket data.
 *   event_id u32 | code_len u8 | code (UTF-8) | url_len u16 | hub URL (UTF-8)
 */
export const SETUP_PREFIX = "DEV1:";

export interface SetupPayload {
  eventId: number;
  /** One-time enrolment code. */
  code: string;
  hubUrl: string;
}

export type SetupDecodeError = "not_setup" | "invalid";
export type SetupDecodeResult =
  { ok: true; setup: SetupPayload } | { ok: false; error: SetupDecodeError };

export function encodeSetupCode(setup: SetupPayload): string {
  const code = new TextEncoder().encode(setup.code);
  const url = new TextEncoder().encode(setup.hubUrl);
  if (!Number.isInteger(setup.eventId) || setup.eventId < 0 || setup.eventId > 0xffffffff) {
    throw new RangeError("eventId out of range");
  }
  if (code.length === 0 || code.length > 0xff) throw new RangeError("code must be 1-255 bytes");
  if (url.length > 0xffff) throw new RangeError("hub URL too long");
  const out = new Uint8Array(4 + 1 + code.length + 2 + url.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, setup.eventId);
  view.setUint8(4, code.length);
  out.set(code, 5);
  view.setUint16(5 + code.length, url.length);
  out.set(url, 7 + code.length);
  return SETUP_PREFIX + base45Encode(out);
}

export function decodeSetupCode(raw: string): SetupDecodeResult {
  if (!raw.startsWith(SETUP_PREFIX)) return { ok: false, error: "not_setup" };
  try {
    const bytes = base45Decode(raw.slice(SETUP_PREFIX.length));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eventId = view.getUint32(0);
    const codeLen = view.getUint8(4);
    const urlLen = view.getUint16(5 + codeLen);
    if (codeLen === 0 || bytes.length !== 7 + codeLen + urlLen)
      return { ok: false, error: "invalid" };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return {
      ok: true,
      setup: {
        eventId,
        code: decoder.decode(bytes.slice(5, 5 + codeLen)),
        hubUrl: decoder.decode(bytes.slice(7 + codeLen)),
      },
    };
  } catch {
    return { ok: false, error: "invalid" };
  }
}
