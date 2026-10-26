/**
 * Address classification for the hub DNS check: is the answer for `hub.<domain>` a private (RFC 1918)
 * address, a Cloudflare proxy address, or something else. Pure, no Node imports.
 */

/** Cloudflare's published ranges (https://www.cloudflare.com/ips/). A proxied record answers from these. */
const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];
const CLOUDFLARE_V6 = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];
const PRIVATE_V4 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];
/** Unique local addresses, the IPv6 counterpart of RFC 1918. */
const PRIVATE_V6 = ["fc00::/7"];

export function parseIPv4(text: string): bigint | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(part);
  }
  return value;
}

export function parseIPv6(text: string): bigint | undefined {
  const address = text.split("%")[0]!.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(address) || address.split("::").length > 2) return undefined;
  let tail = address;
  let v4Groups: string[] = [];
  const lastColon = address.lastIndexOf(":");
  if (address.includes(".")) {
    const v4 = parseIPv4(address.slice(lastColon + 1));
    if (v4 === undefined) return undefined;
    v4Groups = [((v4 >> 16n) & 0xffffn).toString(16), (v4 & 0xffffn).toString(16)];
    tail = address.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = tail.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  let groups: string[];
  if (rest === undefined) groups = left;
  else {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return undefined;
    groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  }
  if (v4Groups.length) groups = [...groups.slice(0, 6), ...v4Groups];
  if (groups.length !== 8) return undefined;
  let value = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    value = (value << 16n) | BigInt(`0x${g}`);
  }
  return value;
}

function inRange(value: bigint, bits: number, cidr: string): boolean {
  const [base, prefix] = cidr.split("/") as [string, string];
  const baseValue = bits === 32 ? parseIPv4(base) : parseIPv6(base);
  if (baseValue === undefined) return false;
  const shift = BigInt(bits - Number(prefix));
  return value >> shift === baseValue >> shift;
}

export type AddressKind = "private" | "cloudflare" | "public" | "invalid";

export function classifyAddress(address: string): AddressKind {
  const v4 = parseIPv4(address);
  if (v4 !== undefined) {
    if (PRIVATE_V4.some((c) => inRange(v4, 32, c))) return "private";
    if (CLOUDFLARE_V4.some((c) => inRange(v4, 32, c))) return "cloudflare";
    return "public";
  }
  const v6 = parseIPv6(address);
  if (v6 === undefined) return "invalid";
  if (PRIVATE_V6.some((c) => inRange(v6, 128, c))) return "private";
  if (CLOUDFLARE_V6.some((c) => inRange(v6, 128, c))) return "cloudflare";
  return "public";
}
