import { X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

let cached: { path: string; mtimeMs: number; expiresAt: number | null } | undefined;

/**
 * Expiry (Unix seconds) of the first certificate in the PEM file the hub's proxy serves
 * (`HUB_CERT_PATH`), or null when none is configured or it cannot be read. Cached until the file changes.
 */
export function certExpiresAt(path: string | undefined): number | null {
  if (!path) return null;
  try {
    const { mtimeMs } = statSync(path);
    if (cached?.path === path && cached.mtimeMs === mtimeMs) return cached.expiresAt;
    const ms = Date.parse(new X509Certificate(readFileSync(path)).validTo);
    const expiresAt = Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    cached = { path, mtimeMs, expiresAt };
    return expiresAt;
  } catch {
    return null;
  }
}
