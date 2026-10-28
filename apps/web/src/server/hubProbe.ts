/**
 * The network probes behind the hub setup page's server-side checks: a public DNS lookup (step 2)
 * and a TLS handshake with the hub (step 3). Both are injectable so tests never touch the network.
 */
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { connect } from "node:tls";
import { classifyAddress, type DnsLookup } from "@events-qr/core";
import type { Config } from "./config";

const PROBE_TIMEOUT_MS = 4000;

/** `name=ip;ip,name2=` -> a map; an empty list means the test hook answers "no record". */
export function parseDnsAnswers(raw: string | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of (raw ?? "").split(",")) {
    const [name, list = ""] = entry.split("=");
    if (name?.trim())
      out.set(
        name.trim().toLowerCase(),
        list
          .split(";")
          .map((a) => a.trim())
          .filter(Boolean),
      );
  }
  return out;
}

/** Asks a public resolver (not the VM's own) for the host's A and AAAA records. */
export async function publicDnsLookup(config: Config, host: string): Promise<DnsLookup> {
  const fixed = parseDnsAnswers(config.HUB_CHECK_DNS_ANSWERS).get(host);
  if (fixed)
    return fixed.length
      ? { host, addresses: fixed, resolver: "test hook" }
      : { host, addresses: [], error: "nxdomain", resolver: "test hook" };
  const resolver = new Resolver({ timeout: PROBE_TIMEOUT_MS, tries: 1 });
  resolver.setServers([config.HUB_CHECK_DNS_SERVER]);
  const answers: string[] = [];
  let failure: string | undefined;
  for (const kind of ["resolve4", "resolve6"] as const) {
    try {
      answers.push(...(await resolver[kind](host)));
    } catch (err) {
      const code = (err as { code?: string }).code ?? "ERROR";
      // "No such name" and "no records of this type" both mean there is nothing to find.
      if (code !== "ENOTFOUND" && code !== "ENODATA") failure = code;
    }
  }
  return {
    host,
    addresses: answers,
    resolver: config.HUB_CHECK_DNS_SERVER,
    ...(answers.length === 0 ? { error: failure ?? "nxdomain" } : {}),
  };
}

export interface TlsProbeResult {
  authorized: boolean;
  /** Certificate `notAfter` as Unix seconds, null when it could not be read. */
  expiresAt: number | null;
}

/** Opens a TLS connection to `address:port` asking for `servername`; undefined when it cannot connect. */
export type TlsProbe = (target: {
  address: string;
  port: number;
  servername: string;
}) => Promise<TlsProbeResult | undefined>;

export const tlsProbe: TlsProbe = ({ address, port, servername }) =>
  new Promise((resolve) => {
    // Only addresses the DNS check classed as private are probed: this is the hub's own LAN, never a public host.
    if (classifyAddress(address) !== "private") return resolve(undefined);
    const socket = connect({
      host: address,
      port,
      servername: isIP(servername) ? undefined : servername,
      rejectUnauthorized: false,
      timeout: PROBE_TIMEOUT_MS,
    });
    const done = (value: TlsProbeResult | undefined) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("secureConnect", () => {
      const validTo = socket.getPeerCertificate().valid_to;
      const ms = validTo ? Date.parse(validTo) : NaN;
      done({
        authorized: socket.authorized,
        expiresAt: Number.isNaN(ms) ? null : Math.floor(ms / 1000),
      });
    });
    socket.once("timeout", () => done(undefined));
    socket.once("error", () => done(undefined));
  });

/** The host (and port) of a hub address typed as `hub.example.org`, `https://hub.example.org` or with a port. */
export function parseHubAddress(
  raw: string,
): { host: string; port: number; https: boolean } | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) return undefined;
    const https = url.protocol === "https:";
    return { host, port: url.port ? Number(url.port) : https ? 443 : 80, https };
  } catch {
    return undefined;
  }
}
