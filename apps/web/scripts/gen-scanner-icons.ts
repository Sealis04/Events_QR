/** Writes the scanner PWA icons (QR-like glyph on the app's dark background): `bun scripts/gen-scanner-icons.ts` from apps/web. */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const CELLS = 9;

/** Three finder squares (rings around a dark centre) plus a fixed speckle, like a QR code. */
function lit(cx: number, cy: number): boolean {
  const finder = (ox: number, oy: number): boolean | undefined => {
    const x = cx - ox;
    const y = cy - oy;
    if (x < 0 || y < 0 || x > 2 || y > 2) return undefined;
    return !(x === 1 && y === 1);
  };
  for (const hit of [finder(0, 0), finder(CELLS - 3, 0), finder(0, CELLS - 3)]) {
    if (hit !== undefined) return hit;
  }
  return (cx * 7 + cy * 13 + cx * cy) % 3 === 0;
}

function icon(size: number): Buffer {
  const png = new PNG({ width: size, height: size });
  const margin = Math.round(size * 0.2); // inside the maskable safe zone
  const cell = Math.floor((size - margin * 2) / CELLS);
  const origin = Math.floor((size - cell * CELLS) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.floor((x - origin) / cell);
      const cy = Math.floor((y - origin) / cell);
      const on = cx >= 0 && cy >= 0 && cx < CELLS && cy < CELLS && lit(cx, cy);
      const [r, g, b] = on ? [249, 250, 251] : [17, 24, 39];
      const i = (y * size + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const out = resolve(import.meta.dirname, "../public/scan");
for (const size of [192, 512]) writeFileSync(resolve(out, `icon-${size}.png`), icon(size));
console.log("wrote scanner icons");
