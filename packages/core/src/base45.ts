/** Base45 (RFC 9285). Uses only the QR alphanumeric character set. */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const LOOKUP = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base45Encode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = (bytes[i] as number) * 256 + (bytes[i + 1] as number);
      out +=
        ALPHABET[n % 45]! + ALPHABET[Math.floor(n / 45) % 45]! + ALPHABET[Math.floor(n / 2025)]!;
    } else {
      const n = bytes[i] as number;
      out += ALPHABET[n % 45]! + ALPHABET[Math.floor(n / 45)]!;
    }
  }
  return out;
}

/** Throws on characters outside the alphabet, bad length or out-of-range groups. */
export function base45Decode(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new Error("invalid base45 length");
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 3) {
    const c = LOOKUP.get(text[i]!);
    const d = LOOKUP.get(text[i + 1]!);
    if (c === undefined || d === undefined) throw new Error("invalid base45 character");
    if (i + 2 < text.length) {
      const e = LOOKUP.get(text[i + 2]!);
      if (e === undefined) throw new Error("invalid base45 character");
      const n = c + d * 45 + e * 2025;
      if (n > 0xffff) throw new Error("invalid base45 group");
      out.push(n >> 8, n & 0xff);
    } else {
      const n = c + d * 45;
      if (n > 0xff) throw new Error("invalid base45 group");
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}
