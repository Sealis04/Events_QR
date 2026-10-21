/**
 * QR decoding: the browser's `BarcodeDetector` where it exists, otherwise ZXing compiled to WASM.
 * The WASM file is bundled with the app (a hashed `/_next/static/media/` URL the service worker
 * caches), never fetched from a CDN, so scanning keeps working with the network off.
 */
import { prepareZXingModule, readBarcodesFromImageData } from "zxing-wasm/reader";

export interface FrameDecoder {
  readonly engine: "barcode-detector" | "zxing-wasm";
  /** Text of the first QR code in the frame, or null. */
  decode(frame: HTMLVideoElement | HTMLCanvasElement): Promise<string | null>;
}

/** Decodes raw RGBA pixels. Also used by tests, where `overrides` supplies the WASM bytes. */
export async function decodeImageData(image: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}): Promise<string | null> {
  const results = await readBarcodesFromImageData(image as ImageData, {
    formats: ["QRCode"],
    maxNumberOfSymbols: 1,
    tryHarder: false,
    tryInvert: true,
  });
  const hit = results.find((r) => r.isValid && r.text);
  return hit ? hit.text : null;
}

/** Points ZXing at the bundled WASM file (browser) or at bytes read by the caller (Node tests). */
export function configureZxing(overrides?: Parameters<typeof prepareZXingModule>[0]): void {
  prepareZXingModule(
    overrides ?? {
      overrides: {
        locateFile: (path: string, prefix: string) =>
          path.endsWith(".wasm")
            ? new URL("zxing-wasm/reader/zxing_reader.wasm", import.meta.url).href
            : prefix + path,
      },
    },
  );
}

/** Starts loading the WASM so it is in the service-worker cache before the camera needs it. */
export function warmZxing(): void {
  configureZxing();
  void prepareZXingModule({ fireImmediately: true }).catch(() => undefined);
}

const MAX_SIDE = 640;

function zxingDecoder(): FrameDecoder {
  configureZxing();
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  return {
    engine: "zxing-wasm",
    async decode(frame) {
      if (!ctx) return null;
      const w = frame instanceof HTMLVideoElement ? frame.videoWidth : frame.width;
      const h = frame instanceof HTMLVideoElement ? frame.videoHeight : frame.height;
      if (!w || !h) return null;
      const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      return decodeImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    },
  };
}

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = {
  new (options: { formats: string[] }): DetectorLike;
  getSupportedFormats(): Promise<string[]>;
};

export async function createFrameDecoder(): Promise<FrameDecoder> {
  const Detector = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
  if (Detector) {
    try {
      if ((await Detector.getSupportedFormats()).includes("qr_code")) {
        const detector = new Detector({ formats: ["qr_code"] });
        return {
          engine: "barcode-detector",
          async decode(frame) {
            const found = await detector.detect(frame);
            return found[0]?.rawValue ?? null;
          },
        };
      }
    } catch {
      // fall through to ZXing
    }
  }
  return zxingDecoder();
}
