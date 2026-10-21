import { api, decodeSetupCode } from "@events-qr/core";
import { HttpClient, type HubClient } from "./client";
import type { DeviceRecord, ScannerStore } from "./types";

/** Ticket pages until the server says there are no more. Returns how many rows came in. */
export async function syncAll(
  store: ScannerStore,
  client: HubClient,
  nowLocal: () => number = () => Math.floor(Date.now() / 1000),
): Promise<DeviceRecord> {
  let device = await store.getDevice();
  if (!device) throw new Error("device is not enrolled");
  for (;;) {
    const res = await client.sync(device.cursor);
    const parsed = api.hubSyncResponse.parse(res);
    await store.putTickets(parsed.tickets);
    const mine = parsed.devices.find((d) => d.id === device!.deviceId);
    device = {
      ...device,
      cursor: parsed.next_cursor ?? device.cursor,
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
 * "Set up for event": decode the `DEV1:` QR, exchange its one-time code at the server named in it
 * (the page's own origin when that is the same host, so the install works behind any proxy), store
 * the device, then run the full ticket sync. Only after that does the phone accept tickets.
 */
export async function enrollFromSetupQr(
  store: ScannerStore,
  raw: string,
  options: { fetch?: typeof fetch; newId?: () => string; originOverride?: string } = {},
): Promise<DeviceRecord> {
  const decoded = decodeSetupCode(raw.trim());
  if (!decoded.ok) {
    throw new EnrollFailed(decoded.error, "This is not a scanner setup code");
  }
  const { code, hubUrl } = decoded.setup;
  const serverUrl = (options.originOverride ?? hubUrl).replace(/\/+$/, "");
  const deviceId = (options.newId ?? (() => crypto.randomUUID()))();
  const doFetch = options.fetch ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`${serverUrl}/api/devices/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device_id: deviceId }),
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new EnrollFailed("network", "Could not reach the server");
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new EnrollFailed(
      res.status === 401 ? "wrong_code" : "invalid",
      data?.error?.message ?? "Setup failed",
    );
  }
  const parsed = api.enrollExchangeResponse.parse(data);

  await store.wipe();
  const device: DeviceRecord = {
    deviceId: parsed.device_id,
    token: parsed.device_token,
    serverUrl,
    gate: parsed.gate,
    direction: parsed.direction,
    label: parsed.label,
    bundle: parsed.key_bundle,
    clockOffset: 0,
    cursor: null,
    synced: false,
    ticketTypes: parsed.key_bundle.ticket_types,
  };
  await store.setDevice(device);
  return syncAll(
    store,
    new HttpClient({ baseUrl: serverUrl, token: device.token, fetch: options.fetch }),
  );
}
