import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  encodeEntryRule,
  generateEventKey,
  verifyToken,
  type TicketPayload,
} from "@events-qr/core";
import {
  createSigningKeyFile,
  retireSigningKey,
  rotateSigningKey,
  Signer,
  SigningKeyUnavailable,
} from "../src/server/signing";
import { decryptEventKey, encryptEventKey, parseMasterKey } from "../src/server/secrets";
import { localDayZero, isValidTimezone } from "../src/server/time";
import { loadConfig } from "../src/server/config";

const payload = (keyId: number): TicketPayload => ({
  version: 1,
  eventId: 7,
  ticketId: new Uint8Array(16).fill(9),
  ticketType: 0,
  issuedAt: 1_800_000_000,
  keyId,
  entryRule: encodeEntryRule("single"),
  gateMask: 0,
  slotStart: 0xffff,
  slotEnd: 0xffff,
});

describe("signing key file", () => {
  let dir: string;
  let path: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "eqr-sign-"));
    path = join(dir, "key.json");
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("is created encrypted, readable only by its owner, and never overwritten", async () => {
    const { keyId, publicKey } = await createSigningKeyFile(path, "correct passphrase");
    expect(keyId).toBe(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const text = await readFile(path, "utf8");
    expect(text).toContain(publicKey);
    expect(text).not.toContain("correct passphrase");
    await expect(createSigningKeyFile(path, "other")).rejects.toThrow(/already exists/);
  });

  it("loads with the right passphrase, mints verifiable tokens and refuses the wrong passphrase", async () => {
    const signer = await Signer.load(path, "correct passphrase");
    expect(signer.currentKeyId).toBe(1);
    const eventKey = generateEventKey();
    const token = await signer.mint(payload(1), eventKey);
    expect((await verifyToken(token, signer.publicKeys(), eventKey, 7)).ok).toBe(true);
    await expect(Signer.load(path, "wrong")).rejects.toThrow();
  });

  it("rotates: the new key is current, old tickets still verify and can be re-minted", async () => {
    const before = await Signer.load(path, "correct passphrase");
    const eventKey = generateEventKey();
    const nonce = new Uint8Array(12).fill(3);
    const oldToken = await before.mint(payload(1), eventKey, nonce);

    await expect(rotateSigningKey(path, "wrong")).rejects.toThrow();
    const { keyId } = await rotateSigningKey(path, "correct passphrase");
    expect(keyId).toBe(2);
    const after = await Signer.load(path, "correct passphrase");
    expect(after.currentKeyId).toBe(2);
    expect([...after.publicKeys().keys()].sort()).toEqual([1, 2]);
    expect(await after.mint(payload(1), eventKey, nonce)).toBe(oldToken); // byte-identical re-send
    expect((await verifyToken(oldToken, after.publicKeys(), eventKey, 7)).ok).toBe(true);
    const fresh = await after.mint(payload(2), eventKey);
    expect((await verifyToken(fresh, after.publicKeys(), eventKey, 7)).ok).toBe(true);
  });

  it("retiring a key drops its secret but its public key keeps verifying", async () => {
    const eventKey = generateEventKey();
    const old = await (await Signer.load(path, "correct passphrase")).mint(payload(1), eventKey);
    await expect(retireSigningKey(path, 2)).rejects.toThrow(/current/);
    await retireSigningKey(path, 1);
    const signer = await Signer.load(path, "correct passphrase");
    expect((await verifyToken(old, signer.publicKeys(), eventKey, 7)).ok).toBe(true);
    await expect(signer.mint(payload(1), eventKey)).rejects.toThrow(SigningKeyUnavailable);
  });

  it("rejects a corrupted file", async () => {
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{}");
    await expect(Signer.load(bad, "x")).rejects.toThrow();
  });
});

describe("event key encryption", () => {
  const master = generateEventKey();
  it("round-trips and binds to the master key", () => {
    const key = generateEventKey();
    const ref = encryptEventKey(key, master);
    expect(ref).toMatch(/^v1:/);
    expect(decryptEventKey(ref, master)).toEqual(key);
    expect(() => decryptEventKey(ref, generateEventKey())).toThrow();
    expect(() => decryptEventKey(ref.slice(0, -4) + "AAAA", master)).toThrow();
  });
  it("accepts hex or base64 masters of 32 bytes only", () => {
    expect(parseMasterKey("ab".repeat(32))).toHaveLength(32);
    expect(parseMasterKey(Buffer.alloc(32, 1).toString("base64"))).toHaveLength(32);
    expect(() => parseMasterKey("short")).toThrow();
  });
});

describe("local day zero", () => {
  it("finds 00:00 local on the event's first day", () => {
    const noon = Date.UTC(2027, 5, 10, 12, 0, 0) / 1000;
    expect(localDayZero(noon, "UTC")).toBe(Date.UTC(2027, 5, 10) / 1000);
    expect(localDayZero(noon, "Asia/Manila")).toBe(Date.UTC(2027, 5, 9, 16) / 1000); // UTC+8
    expect(localDayZero(noon, "America/New_York")).toBe(Date.UTC(2027, 5, 10, 4) / 1000); // UTC-4 (DST)
    const lateUtc = Date.UTC(2027, 5, 10, 23, 0, 0) / 1000; // already the 11th in Manila
    expect(localDayZero(lateUtc, "Asia/Manila")).toBe(Date.UTC(2027, 5, 10, 16) / 1000);
    // A zone that changes offset on that day.
    const dstDay = Date.UTC(2027, 2, 14, 20, 0, 0) / 1000;
    expect(localDayZero(dstDay, "America/New_York")).toBe(Date.UTC(2027, 2, 14, 5) / 1000);
    expect(isValidTimezone("Asia/Manila")).toBe(true);
    expect(isValidTimezone("Mars/Base")).toBe(false);
  });
});

describe("config", () => {
  it("applies defaults and reports bad values", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ APP_MODE: "server", DB_PORT: 3306, EMAIL_DAILY_LIMIT: 1800 });
    expect(() => loadConfig({ APP_MODE: "nope" })).toThrow(/APP_MODE/);
    expect(() => loadConfig({ SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(loadConfig({ DB_PASSWORD: "" }).DB_PASSWORD).toBe(""); // blank means unset
  });
});
