/**
 * Hub first, VM second (docs/spec.md "Scanner app", plan M4). A phone asks the venue hub for every
 * claim, exit and sync, with an 800 ms limit. If the hub does not answer in time (or does not know
 * this phone or ticket yet) the same request goes to the VM, and the pill shows Cloud-only. The hub
 * is tried again on the next scan, so a hub that comes back is used straight away.
 *
 * A retried request keeps its `scan_id`, so if a slow hub did decide the scan after all, the VM
 * gets the same id and the two copies collapse into one row when they sync.
 */
import { ApiRejected, AuthError, HttpClient, NetworkError, type HubClient } from "./client";
import type { DeviceRecord } from "./types";

export const HUB_TIMEOUT_MS = 800;
export const CLOUD_TIMEOUT_MS = 4000;

export type Link = "hub" | "cloud" | "offline";

const trim = (url: string): string => url.replace(/\/+$/, "");

export function cloudBase(device: DeviceRecord): string | null {
  return device.cloudUrl === undefined ? trim(device.serverUrl) : device.cloudUrl;
}

/** The hub's address, or null when the phone has none (or it is the VM itself). */
export function hubBase(device: DeviceRecord): string | null {
  if (!device.hubUrl) return null;
  const hub = trim(device.hubUrl);
  return hub === cloudBase(device) ? null : hub;
}

export interface Clients {
  hub: HttpClient | null;
  cloud: HttpClient | null;
  /**
   * The server the phone enrolled at. Only it can say "this device is no longer enrolled": the
   * other may simply not have heard of the phone yet (the hub pulls new devices every 30 s, and
   * pushes the ones enrolled at it every 5 s), which must not wipe the phone.
   */
  authority: "hub" | "cloud";
}

/** An AuthError from the server that is not the authority only means "not known here yet". */
export async function asked<T>(
  clients: Clients,
  from: "hub" | "cloud",
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof AuthError && from !== clients.authority)
      throw new NetworkError("this phone is not known there yet");
    throw err;
  }
}

/** Hub down, or the hub does not know this phone or ticket (yet): the VM may. */
const hubCannotHelp = (err: unknown): boolean =>
  err instanceof NetworkError || (err instanceof ApiRejected && err.status === 404);

export function clientsFor(
  device: DeviceRecord,
  options: { fetch?: typeof fetch; hubTimeoutMs?: number; cloudTimeoutMs?: number } = {},
): Clients {
  const hub = hubBase(device);
  const cloud = cloudBase(device);
  return {
    authority: hub !== null && trim(device.serverUrl) === hub ? "hub" : "cloud",
    hub: hub
      ? new HttpClient({
          baseUrl: hub,
          token: device.token,
          fetch: options.fetch,
          timeoutMs: options.hubTimeoutMs ?? HUB_TIMEOUT_MS,
        })
      : null,
    cloud:
      cloud !== null
        ? new HttpClient({
            baseUrl: cloud,
            token: device.token,
            fetch: options.fetch,
            timeoutMs: options.cloudTimeoutMs ?? CLOUD_TIMEOUT_MS,
          })
        : null,
  };
}

/** `claim` and `exit` through the hub, falling back to the VM; remembers which one answered. */
export class RoutedClient implements HubClient {
  route: Link | null = null;

  constructor(
    private readonly clients: Clients,
    private readonly onRoute?: (link: Link) => void,
  ) {}

  private setRoute(link: Link): void {
    this.route = link;
    this.onRoute?.(link);
  }

  private async via<T>(call: (client: HubClient) => Promise<T>): Promise<T> {
    const { hub, cloud } = this.clients;
    if (hub) {
      try {
        const result = await asked(this.clients, "hub", () => call(hub));
        this.setRoute("hub");
        return result;
      } catch (err) {
        if (!hubCannotHelp(err) || !cloud) {
          if (err instanceof NetworkError) this.setRoute("offline");
          throw err;
        }
      }
    }
    if (!cloud) throw new NetworkError("no server to ask");
    try {
      const result = await asked(this.clients, "cloud", () => call(cloud));
      this.setRoute("cloud");
      return result;
    } catch (err) {
      if (err instanceof NetworkError) this.setRoute("offline");
      throw err;
    }
  }

  claim: HubClient["claim"] = (body) => this.via((c) => c.claim(body));
  exit: HubClient["exit"] = (body) => this.via((c) => c.exit(body));
  sync: HubClient["sync"] = (cursor) => this.via((c) => c.sync(cursor));
  health: HubClient["health"] = () => this.via((c) => c.health());
}
