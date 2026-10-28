import type { Config } from "./config";

/**
 * What `HUB_URL` (the address put into phone setup QRs) amounts to:
 *  - `unset`: not configured, so QRs carry the server's own address;
 *  - `local`: a phone cannot use it (`localhost`, `127.*`, `host.docker.internal`, a bare IP,
 *    or plain `http://`, which a hub with secure cookies cannot serve);
 *  - `ok`: an https address with a real name.
 */
export type HubUrlStatus = "unset" | "local" | "ok";

export function classifyHubUrl(value: string | undefined | null): HubUrlStatus {
  const raw = value?.trim();
  if (!raw) return "unset";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "local";
  }
  if (url.protocol !== "https:") return "local";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "host.docker.internal" ||
    host.includes(":") ||
    /^\d+(\.\d+){0,3}$/.test(host)
  )
    return "local";
  return "ok";
}

export interface HubUrlWarning {
  status: "unset" | "local";
  value: string | null;
}

/** The warning the Devices and Hub setup tabs show, only when the event has a linked (not revoked) hub. */
export function hubUrlWarning(
  config: Pick<Config, "HUB_URL">,
  hubs: { revoked: boolean }[],
): HubUrlWarning | null {
  if (!hubs.some((h) => !h.revoked)) return null;
  const status = classifyHubUrl(config.HUB_URL);
  return status === "ok" ? null : { status, value: config.HUB_URL ?? null };
}
