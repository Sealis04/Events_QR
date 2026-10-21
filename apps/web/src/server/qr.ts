import QRCode from "qrcode";

export interface RenderedQr {
  pngBytes: Buffer;
  /** `data:image/png;base64,...` */
  pngDataUrl: string;
  svg: string;
}

// Base45 is inside the QR alphanumeric set, so force that mode: it keeps the code at ~version 10.
const segments = (token: string) => [{ data: token, mode: "alphanumeric" as const }];
const BASE = { errorCorrectionLevel: "M" as const, margin: 4 };

/** Level M, 4-module quiet zone, 6 px per module (about 390 px). */
export async function renderQr(token: string): Promise<RenderedQr> {
  const [pngBytes, svg] = await Promise.all([
    QRCode.toBuffer(segments(token), { ...BASE, scale: 6, type: "png" }),
    QRCode.toString(segments(token), { ...BASE, type: "svg" }),
  ]);
  return { pngBytes, pngDataUrl: `data:image/png;base64,${pngBytes.toString("base64")}`, svg };
}
