"use client";

import type { HealthFetch, HubCheckStep } from "@events-qr/core";

export interface StepDef {
  key: HubCheckStep;
  part: 1 | 2;
  title: string;
  /** What this step proves, in plain words. */
  blurb: string;
  /** Where the check can run: the VM's page, the hub's own page, or both. */
  runsOn: "both" | "vm" | "hub";
}

export const STEPS: StepDef[] = [
  {
    key: "hub_running",
    part: 1,
    title: "The hub is running",
    blurb:
      "Your browser asks the hub machine for its health page. This proves the hub stack is up and the address you typed reaches it.",
    runsOn: "both",
  },
  {
    key: "dns_record",
    part: 1,
    title: "The hub name has a record",
    blurb:
      "The VM asks public DNS for the hub's name. The answer must be the hub's private LAN address, and not a Cloudflare address (the cloud must be grey).",
    runsOn: "vm",
  },
  {
    key: "certificate",
    part: 1,
    title: "The certificate is valid",
    blurb:
      "Phones need a trusted HTTPS certificate on the hub's name. The check shows how many days are left and warns under 30.",
    runsOn: "both",
  },
  {
    key: "link_hub",
    part: 1,
    title: "The hub is linked to this event",
    blurb:
      "Make a one-time setup code, run the command on the hub machine, then check: the hub must have contacted the VM in the last 2 minutes and pulled tickets.",
    runsOn: "vm",
  },
  {
    key: "local_dns",
    part: 2,
    title: "The hub name works on the venue Wi-Fi",
    blurb:
      "Open this page on a laptop or phone on the venue Wi-Fi. The browser fetches https://hub.<domain>/api/health and must get an answer from a hub.",
    runsOn: "both",
  },
  {
    key: "data_match",
    part: 2,
    title: "Tickets and staff on the hub match the VM",
    blurb:
      "The hub compares what it holds with what the VM holds: tickets by status and the staff who may log in. It passes when they are equal, or the hub is less than one pull interval behind.",
    runsOn: "hub",
  },
  {
    key: "phone_via_hub",
    part: 2,
    title: "A phone works through the hub",
    blurb:
      "Set up a phone on the venue Wi-Fi from a hub setup code and scan one ticket. This passes when a phone of this event reported through the hub in the last 5 minutes.",
    runsOn: "hub",
  },
  {
    key: "offline_scan",
    part: 2,
    title: "A scan works with the internet unplugged",
    blurb:
      "Unplug the hub's uplink, scan the rehearsal test ticket, plug the uplink back in. This passes when that scan is on the hub from while the uplink was down, and the VM received it afterwards.",
    runsOn: "hub",
  },
];

/** What the browser sees at `<address>/api/health` (CORS is open on that one route). */
export async function fetchHealth(address: string): Promise<HealthFetch> {
  const base = address.trim().replace(/\/+$/, "");
  const url = `${/^https?:\/\//i.test(base) ? base : `https://${base}`}/api/health`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      mode: "cors",
      signal: AbortSignal.timeout(6000),
    });
    const body: unknown = await res.json().catch(() => undefined);
    return { url, reached: true, status: res.status, body };
  } catch (err) {
    return { url, reached: false, error: err instanceof Error ? err.message : "network error" };
  }
}

/** The host name of a hub address, or "" when it is not a usable name. */
export function hostOf(address: string): string {
  try {
    return new URL(
      /^[a-z]+:\/\//i.test(address.trim()) ? address.trim() : `https://${address.trim()}`,
    ).hostname;
  } catch {
    return "";
  }
}

/** `https://tickets.example.org` -> `https://hub.example.org`, a starting guess for the hub's address. */
export function guessHubAddress(pageHost: string): string {
  const labels = pageHost.split(".");
  if (labels.length < 3 || /^\d+$/.test(labels[labels.length - 1]!)) return "";
  return `https://hub.${labels.slice(1).join(".")}`;
}
