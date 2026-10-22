/**
 * One pass of the phone's background work, every 10 s and whenever the browser says it is back
 * online: upload the outbox (hub first, else the VM), then pull ticket changes and settings, then
 * apply the two wipe rules of docs/spec.md "Security":
 *
 *   revoked  the server refuses this device's token: keys, ticket list and outbox are deleted
 *            (the outbox was uploaded first when a server could be reached)
 *   ended    once the event is over, event keys and ticket lists are deleted; scans that could not
 *            be uploaded yet stay (with the device token) until they are
 *
 * Kept free of React so every branch is unit-tested.
 */
import { AuthError, NetworkError } from "./client";
import { drainOutbox } from "./outbox";
import { clientsFor, type Clients, type Link } from "./routes";
import { syncFromBest } from "./sync";
import type { DeviceRecord, ScannerStore } from "./types";

/** Event keys are wiped this long after `ends_at` (late exits, last uploads). */
export const END_GRACE_SECONDS = 2 * 3600;

export type CycleResult =
  | { kind: "ok"; device: DeviceRecord; link: Link; outbox: number }
  | { kind: "offline"; device: DeviceRecord; outbox: number }
  | { kind: "revoked" }
  | { kind: "ended"; device: DeviceRecord | undefined; outbox: number };

export interface CycleOptions {
  clients?: Clients;
  /** Local clock, Unix seconds (the corrected clock is used for the end-of-event rule). */
  nowLocal?: () => number;
}

export async function syncCycle(
  store: ScannerStore,
  device: DeviceRecord,
  options: CycleOptions = {},
): Promise<CycleResult> {
  const nowLocal = options.nowLocal ?? (() => Math.floor(Date.now() / 1000));
  const clients = options.clients ?? clientsFor(device, { cloudTimeoutMs: 4000 });
  const revoked = async (): Promise<CycleResult> => {
    await store.wipe();
    return { kind: "revoked" };
  };

  if (device.ended) return endedCycle(store, device, clients);

  try {
    await drainOutbox(store, clients);
  } catch (err) {
    if (err instanceof AuthError) return revoked();
    throw err;
  }

  let result: Extract<CycleResult, { kind: "ok" | "offline" }>;
  try {
    const { device: next, link } = await syncFromBest(store, clients, nowLocal);
    result = { kind: "ok", device: next, link, outbox: await store.outboxCount() };
  } catch (err) {
    if (err instanceof AuthError) return revoked();
    if (!(err instanceof NetworkError)) throw err;
    result = { kind: "offline", device, outbox: await store.outboxCount() };
  }

  const now = nowLocal() + result.device.clockOffset;
  if (now > result.device.bundle.ends_at + END_GRACE_SECONDS)
    return endedCycle(store, result.device, clients);
  return result;
}

/** After the event: a last upload, then everything goes; unsent scans keep the token alive. */
async function endedCycle(
  store: ScannerStore,
  device: DeviceRecord,
  clients: Clients,
): Promise<CycleResult> {
  try {
    await drainOutbox(store, clients);
  } catch (err) {
    if (!(err instanceof AuthError) && !(err instanceof NetworkError)) throw err;
  }
  const outbox = await store.outboxCount();
  if (outbox === 0) {
    await store.wipe();
    return { kind: "ended", device: undefined, outbox: 0 };
  }
  await store.wipeTickets();
  const kept: DeviceRecord = {
    ...device,
    ended: true,
    synced: false,
    staff: [],
    bundle: { ...device.bundle, event_key: "", public_keys: {} },
  };
  await store.setDevice(kept);
  return { kind: "ended", device: kept, outbox };
}
