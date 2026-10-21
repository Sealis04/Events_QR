import { describe, expect, it } from "vitest";
import {
  base45Decode,
  base45Encode,
  buildPayload,
  bytesToHex,
  checkEntry,
  generateEventKey,
  generateSigningKeyPair,
  hexToBytes,
  mintToken,
  parsePayload,
  shortTicketId,
  verifyToken,
} from "../src";
import { EVENT_ID, EVENT_KEY, NONCE, samplePayload, sampleKeys } from "./fixtures";

/** Known-answer vector: any change to the byte layout or crypto framing breaks this. */
const VECTOR_PAYLOAD_HEX = "0100001092f0efeeedecebeae9e8e7e6e5e4e3e2e1026b49d20001830005ffffffff";
const VECTOR_TOKEN =
  "EVT1:I12$C2BO2UZ2423ND3V-IC EJV92JBD5FQ8H1CENOB9*2UBWC+1+GR9THCF0E7HA H4%BS265H1FUO ZU74BVYKQRP7O0GCDV+QL1D1KMDI79X2UR412E-ZRIQGWHU3IJ8M7AJTNV5N65$S8.UE+L54ZPM%OO%E:C8GLV60FIZ1AGEABDPR43FH-F0ID3";

describe("base45", () => {
  it("matches the RFC 9285 examples", () => {
    const enc = (s: string) => base45Encode(new TextEncoder().encode(s));
    expect(enc("AB")).toBe("BB8");
    expect(enc("Hello!!")).toBe("%69 VD92EX0");
    expect(enc("base-45")).toBe("UJCLQE7W581");
    expect(new TextDecoder().decode(base45Decode("QED8WEX0"))).toBe("ietf!");
  });
  it("round-trips every length and rejects bad input", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      expect(base45Decode(base45Encode(bytes))).toEqual(bytes);
    }
    expect(() => base45Decode("a")).toThrow();
    expect(() => base45Decode("GGW")).toThrow(); // group above 0xFFFF
    expect(() => base45Decode("ABCD")).toThrow(); // length % 3 === 1
  });
});

describe("payload", () => {
  it("is exactly 34 bytes with the spec layout (big-endian)", () => {
    const bytes = buildPayload(samplePayload());
    expect(bytes.length).toBe(34);
    expect(bytesToHex(bytes)).toBe(VECTOR_PAYLOAD_HEX);
    expect(parsePayload(bytes)).toEqual(samplePayload());
    expect(shortTicketId(samplePayload())).toBe("e3e2e1");
  });
  it("rejects out-of-range fields", () => {
    expect(() => buildPayload(samplePayload({ eventId: 2 ** 32 }))).toThrow();
    expect(() => buildPayload(samplePayload({ ticketType: 256 }))).toThrow();
    expect(() => buildPayload(samplePayload({ ticketId: new Uint8Array(15) }))).toThrow();
    expect(() => parsePayload(new Uint8Array(33))).toThrow();
  });
});

describe("token", () => {
  it("matches the known-answer vector and is 194 characters (189 Base45 + EVT1:)", async () => {
    const k = await sampleKeys();
    const token = await mintToken(samplePayload(), k.privateKey, EVENT_KEY, NONCE);
    expect(token).toBe(VECTOR_TOKEN);
    expect(token.length).toBe(194);
    expect(token.slice(5).length).toBe(189);
  });

  it("round-trips and uses a random nonce by default", async () => {
    const k = await sampleKeys();
    const a = await mintToken(samplePayload(), k.privateKey, EVENT_KEY);
    const b = await mintToken(samplePayload(), k.privateKey, EVENT_KEY);
    expect(a).not.toBe(b);
    const result = await verifyToken(a, k.publicKeys, EVENT_KEY, EVENT_ID);
    expect(result).toEqual({ ok: true, payload: samplePayload() });
    // Deterministic re-send: the same nonce rebuilds a byte-identical token.
    expect(await mintToken(samplePayload(), k.privateKey, EVENT_KEY, NONCE)).toBe(VECTOR_TOKEN);
  });

  it("rejects text without the EVT1: prefix as not_ours", async () => {
    const k = await sampleKeys();
    for (const raw of ["", "hello", "DEV1:ABC", VECTOR_TOKEN.slice(5), "evt1:ABC"]) {
      expect(await verifyToken(raw, k.publicKeys, EVENT_KEY)).toEqual({
        ok: false,
        error: "not_ours",
      });
    }
  });

  it("rejects malformed bodies as invalid", async () => {
    const k = await sampleKeys();
    for (const raw of [
      "EVT1:",
      "EVT1:abc",
      "EVT1:ZZZ",
      VECTOR_TOKEN.slice(0, -3),
      VECTOR_TOKEN + "000",
    ]) {
      expect(await verifyToken(raw, k.publicKeys, EVENT_KEY)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
  });

  it("rejects any single tampered byte (nonce, ciphertext, tag)", async () => {
    const k = await sampleKeys();
    const raw = base45Decode(VECTOR_TOKEN.slice(5));
    expect(raw.length).toBe(126);
    for (const index of [0, 11, 12, 40, 109, 110, 125]) {
      const copy = raw.slice();
      copy[index] = (copy[index] as number) ^ 0x01;
      const tampered = "EVT1:" + base45Encode(copy);
      expect(await verifyToken(tampered, k.publicKeys, EVENT_KEY, EVENT_ID)).toEqual({
        ok: false,
        error: "invalid",
      });
    }
  });

  it("rejects the wrong event key", async () => {
    const k = await sampleKeys();
    const other = generateEventKey();
    expect(await verifyToken(VECTOR_TOKEN, k.publicKeys, other, EVENT_ID)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("rejects a token signed with a different signing key", async () => {
    const k = await sampleKeys();
    const attacker = await generateSigningKeyPair();
    // The attacker knows the event key (a stolen scanner) but not the signing key.
    const forged = await mintToken(samplePayload(), attacker.privateKey, EVENT_KEY, NONCE);
    expect(await verifyToken(forged, k.publicKeys, EVENT_KEY, EVENT_ID)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("rejects a token for another event with wrong_event", async () => {
    const k = await sampleKeys();
    const result = await verifyToken(VECTOR_TOKEN, k.publicKeys, EVENT_KEY, EVENT_ID + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("wrong_event");
      expect(result.payload?.eventId).toBe(EVENT_ID);
    }
  });

  it("rejects an unknown or expired key_id with unknown_key", async () => {
    const k = await sampleKeys();
    expect(
      await verifyToken(VECTOR_TOKEN, new Map([[2, k.publicKey]]), EVENT_KEY, EVENT_ID),
    ).toEqual({
      ok: false,
      error: "unknown_key",
    });
    expect(await verifyToken(VECTOR_TOKEN, {}, EVENT_KEY, EVENT_ID)).toEqual({
      ok: false,
      error: "unknown_key",
    });
    // Object form of the key map works too, and key rotation picks the right key.
    const rotated = await generateSigningKeyPair();
    const keys = { 1: k.publicKey, 2: rotated.publicKey };
    const t2 = await mintToken(samplePayload({ keyId: 2 }), rotated.privateKey, EVENT_KEY);
    expect((await verifyToken(t2, keys, EVENT_KEY, EVENT_ID)).ok).toBe(true);
    expect((await verifyToken(VECTOR_TOKEN, keys, EVENT_KEY, EVENT_ID)).ok).toBe(true);
  });

  it("rejects an unsupported payload version", async () => {
    const k = await sampleKeys();
    const t = await mintToken(samplePayload({ version: 2 }), k.privateKey, EVENT_KEY);
    expect(await verifyToken(t, k.publicKeys, EVENT_KEY, EVENT_ID)).toEqual({
      ok: false,
      error: "invalid",
    });
  });

  it("round-trips hex helpers", () => {
    expect(hexToBytes("00ff10")).toEqual(Uint8Array.from([0, 255, 16]));
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("gate and slot checks on a verified token", () => {
  const dayZero = 1_800_000_000 - (1_800_000_000 % 86400); // any fixed origin
  const ctx = (over: object = {}) => ({
    gateIndex: 0,
    now: dayZero + 600 * 60,
    dayZeroUnix: dayZero,
    earlyEntryMin: 15,
    ...over,
  });

  it("rejects a gate that is not allowed, and lists the allowed ones", async () => {
    const k = await sampleKeys();
    const t = await mintToken(samplePayload({ gateMask: 0b101 }), k.privateKey, EVENT_KEY);
    const v = await verifyToken(t, k.publicKeys, EVENT_KEY, EVENT_ID);
    if (!v.ok) throw new Error("expected ok");
    expect(checkEntry(v.payload, ctx({ gateIndex: 1 }))).toEqual({
      ok: false,
      reason: "wrong_gate",
      allowedGates: [0, 2],
    });
    expect(checkEntry(v.payload, ctx({ gateIndex: 2 })).ok).toBe(true);
  });

  it("rejects before the slot (minus early entry) and after the slot", async () => {
    const k = await sampleKeys();
    const t = await mintToken(
      samplePayload({ gateMask: 0, slotStart: 600, slotEnd: 720 }),
      k.privateKey,
      EVENT_KEY,
    );
    const v = await verifyToken(t, k.publicKeys, EVENT_KEY, EVENT_ID);
    if (!v.ok) throw new Error("expected ok");
    const at = (minute: number) => ctx({ now: dayZero + minute * 60 });
    expect(checkEntry(v.payload, at(584))).toMatchObject({ ok: false, reason: "too_early" });
    expect(checkEntry(v.payload, at(585)).ok).toBe(true); // exactly 15 min early
    expect(checkEntry(v.payload, at(720)).ok).toBe(true);
    expect(checkEntry(v.payload, ctx({ now: dayZero + 720 * 60 + 1 }))).toMatchObject({
      ok: false,
      reason: "slot_ended",
    });
  });
});
