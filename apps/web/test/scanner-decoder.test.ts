import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  bytesToHex,
  checkEntry,
  encodeEntryRule,
  generateEventKey,
  generateSigningKeyPair,
  mintToken,
  verifyToken,
} from "@events-qr/core";
import { configureZxing, decodeImageData } from "../src/scanner/decoder";

const require = createRequire(import.meta.url);

/** Renders a QR to RGBA pixels at roughly what a phone frame shows (about 400 px wide). */
async function qrPixels(text: string, width = 400) {
  const png = PNG.sync.read(await QRCode.toBuffer(text, { errorCorrectionLevel: "M", width }));
  return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
}

describe("QR decoding with the bundled ZXing WASM", () => {
  beforeAll(() => {
    const wasm = readFileSync(require.resolve("zxing-wasm/reader/zxing_reader.wasm"));
    configureZxing({
      overrides: {
        wasmBinary: wasm.buffer.slice(
          wasm.byteOffset,
          wasm.byteOffset + wasm.byteLength,
        ) as ArrayBuffer,
      },
    });
  });

  it("decodes a real EVT1 ticket QR, and frame-to-verified-result stays well under 300 ms", async () => {
    const pair = await generateSigningKeyPair();
    const eventKey = generateEventKey();
    const payload = {
      version: 1,
      eventId: 5,
      ticketId: new Uint8Array(16).fill(7),
      ticketType: 0,
      issuedAt: 1_900_000_000,
      keyId: 1,
      entryRule: encodeEntryRule("single"),
      gateMask: 0,
      slotStart: 0xffff,
      slotEnd: 0xffff,
    };
    const token = await mintToken(payload, pair.privateKey, eventKey);
    const frame = await qrPixels(token);

    expect(await decodeImageData(frame)).toBe(token); // warm-up: loads the WASM module

    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      const text = await decodeImageData(frame);
      const verified = await verifyToken(text!, new Map([[1, pair.publicKey]]), eventKey, 5);
      expect(verified.ok).toBe(true);
      if (verified.ok) {
        expect(bytesToHex(verified.payload.ticketId)).toBe("07".repeat(16));
        expect(
          checkEntry(verified.payload, { gateIndex: 0, now: 0, dayZeroUnix: 0, earlyEntryMin: 15 })
            .ok,
        ).toBe(true);
      }
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[10]!;
    console.info(
      `decode (ZXing WASM, ${frame.width}px) + verify + checks: median ${median.toFixed(1)} ms, max ${times[19]!.toFixed(1)} ms`,
    );
    expect(median).toBeLessThan(300);
  });

  it("returns null for a frame with no QR code", async () => {
    const blank = { data: new Uint8ClampedArray(200 * 200 * 4).fill(255), width: 200, height: 200 };
    expect(await decodeImageData(blank)).toBeNull();
  });

  it("decodes a setup code too", async () => {
    expect(await decodeImageData(await qrPixels("DEV1:ABC123 XYZ"))).toBe("DEV1:ABC123 XYZ");
  });
});
