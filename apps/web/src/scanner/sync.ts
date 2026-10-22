import { api, decodeSetupCode } from "@events-qr/core";
import { NetworkError, type HubClient } from "./client";
import { asked, clientsFor, type Clients, type Link } from "./routes";
import type { DeviceRecord, ScannerStore } from "./types";

/**
 * Ticket pages until the server says there are no more. `field` names the cursor to use: the hub
 * and the VM stamp rows with their own clocks, so a cursor from one means nothing to the other.
 */
export async function syncAll(
  store: ScannerStore,
  client: HubClient,
  nowLocal: () => number = () => Math.floor(Date.now() / 1000),
  field: "cursor" | "cloudCursor" = "cursor",
): Promise<DeviceRecord> {
  let device = await store.getDevice();
  if (!device) throw new Error("device is not enrolled");
  for (;;) {
    const res = await client.sync(device[field] ?? null);
    const parsed = api.hubSyncResponse.parse(res);
    await store.putTickets(parsed.tickets);
    const mine = parsed.devices.find((d) => d.id === device!.deviceId);
    device = {
      ...device,
      [field]: parsed.next_cursor ?? device[field] ?? null,
      clockOffset: parsed.hub_time - nowLocal(),
      ticketTypes: parsed.ticket_types,
      gate: mine?.gate ?? device.gate,
      direction: mine?.direction ?? device.direction,
      synced: parsed.has_more ? device.synced : true,
    };
    await store.setDevice(device);
    if (!parsed.has_more) return device;
  }
}

/**
 * One device pull: from the hub if it answers, otherwise from the VM. Returns the updated device
 * and which server answered (for the pill). Throws NetworkError when neither does, AuthError when
 * the VM (the last word) no longer knows this device.
 */
export async function syncFromBest(
  store: ScannerStore,
  clients: Clients,
  nowLocal?: () => number,
): Promise<{ device: DeviceRecord; link: Link }> {
  if (clients.hub) {
    try {
      return {
        device: await asked(clients, "hub", () => syncAll(store, clients.hub!, nowLocal, "cursor")),
        link: "hub",
      };
    } catch (err) {
      // A hub that is down, or has not heard of this phone yet, is not the end of the road.
      if (!(err instanceof NetworkError) || !clients.cloud) throw err;
    }
    return {
      device: await asked(clients, "cloud", () =>
        syncAll(store, clients.cloud!, nowLocal, "cloudCursor"),
      ),
      link: "cloud",
    };
  }
  if (!clients.cloud) throw new NetworkError("no server to ask");
  return { device: await syncAll(store, clients.cloud, nowLocal, "cursor"), link: "cloud" };
}

export type EnrollError = "not_setup" | "invalid" | "wrong_code" | "network";

export class EnrollFailed extends Error {
  constructor(
    readonly reason: EnrollError,
    message: string,
  ) {
    super(message);
  }
}

/**
 * "Set up for event": decode the `DEV1:` QR, exchange its one-time code at the hub named in it
 * (tried first, so enrolment works with no internet), or at the page's own origin (the VM) when
 * the hub does not answer; store the device, then run the full ticket sync. Only after that does
 * the phone accept tickets. `originOverride` names the one server to use (tests).
 */
export async function enrollFromSetupQr(
  store: ScannerStore,
  raw: string,
  options: {
    fetch?: typeof fetch;
    newId?: () => string;
    originOverride?: string;
    /** The page's own origin: the VM when the page was loaded from it. */
    pageOrigin?: string;
    hubTimeoutMs?: number;
  } = {},
): Promise<DeviceRecord> {
  const decoded = decodeSetupCode(raw.trim());
  if (!decoded.ok) {
    throw new EnrollFailed(decoded.error, "This is not a scanner setup code");
  }
  const { code, hubUrl } = decoded.setup;
  const qrHub = hubUrl.replace(/\/+$/, "");
  const candidates = options.originOverride
    ? [options.originOverride.replace(/\/+$/, "")]
    : [
        ...new Set(
          [qrHub, options.pageOrigin?.replace(/\/+$/, "")].filter((u): u is string => !!u),
        ),
      ];
  const deviceId = (options.newId ?? (() => crypto.randomUUID()))();
  const doFetch = options.fetch ?? fetch;

  let serverUrl = candidates[0]!;
  let res: Response | undefined;
  for (const [i, candidate] of candidates.entries()) {
    try {
      const attempt = await doFetch(`${candidate}/api/devices/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, device_id: deviceId }),
        credentials: "omit",
        // The first choice gets a short window when another server can still be tried.
        signal: AbortSignal.timeout(
          i < candidates.length - 1 ? (options.hubTimeoutMs ?? 3000) : 10_000,
        ),
      });
      serverUrl = candidate;
      res = attempt;
      // A server that errors (a hub that is not linked yet, a proxy in front of nothing) is as
      // good as unreachable while another one can still be tried.
      if (attempt.status < 500 || i === candidates.length - 1) break;
    } catch {
      // unreachable: try the next server
    }
  }
  if (!res) throw new EnrollFailed("network", "Could not reach the server");
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new EnrollFailed(
      res.status === 401 ? "wrong_code" : "invalid",
      data?.error?.message ?? "Setup failed",
    );
  }
  const parsed = api.enrollExchangeResponse.parse(data);

  // Where the VM is: the hub says so in the key bundle; a phone enrolled at the VM knows already.
  const cloudUrl = parsed.key_bundle.cloud_url?.replace(/\/+$/, "") ?? serverUrl;

  await store.wipe();
  const device: DeviceRecord = {
    deviceId: parsed.device_id,
    token: parsed.device_token,
    serverUrl,
    hubUrl: qrHub && qrHub !== cloudUrl ? qrHub : null,
    cloudUrl,
    gate: parsed.gate,
    direction: parsed.direction,
    label: parsed.label,
    bundle: parsed.key_bundle,
    clockOffset: 0,
    cursor: null,
    cloudCursor: null,
    synced: false,
    ticketTypes: parsed.key_bundle.ticket_types,
  };
  await store.setDevice(device);
  const { device: synced } = await syncFromBest(
    store,
    clientsFor(device, { fetch: options.fetch, hubTimeoutMs: options.hubTimeoutMs }),
  );
  return synced;
}
