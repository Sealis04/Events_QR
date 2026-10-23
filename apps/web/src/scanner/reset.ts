/**
 * "Set up again": hand the phone to another event or another person. It first tries to upload the
 * outbox (hub, then VM). Scans still queued after that would be lost with the wipe, so a supervisor
 * has to confirm with their PIN. Then everything goes: device token, event keys, ticket table,
 * staff hashes, outbox and the PIN lockout counter (see `ScannerStore.wipe`).
 */
import { drainOutbox } from "./outbox";
import { clientsFor } from "./routes";
import { isSupervisor, loginStaffAny } from "./staff";
import type { DeviceRecord, ScannerStore } from "./types";

export type SetUpAgainResult =
  | { kind: "wiped"; uploaded: number }
  /** Scans are still queued: ask a supervisor, naming how many would be lost. */
  | { kind: "needs_supervisor"; lost: number };

export class NotSupervisor extends Error {
  constructor() {
    super("That account is not a supervisor");
  }
}

export async function setUpAgain(
  store: ScannerStore,
  device: DeviceRecord,
  options: {
    /** Supervisor credentials, given once the phone has said how many scans would be lost. */
    supervisor?: { name: string; pin: string };
    doFetch?: typeof fetch;
  } = {},
): Promise<SetUpAgainResult> {
  const before = await store.outboxCount();
  // Unreachable servers (or a revoked token) just leave the scans queued.
  await drainOutbox(store, clientsFor(device, { fetch: options.doFetch })).catch(() => undefined);
  const lost = await store.outboxCount();
  if (lost > 0) {
    if (!options.supervisor) return { kind: "needs_supervisor", lost };
    const session = await loginStaffAny(
      store,
      device,
      options.supervisor.name,
      options.supervisor.pin,
      options.doFetch,
    );
    if (!isSupervisor(session)) throw new NotSupervisor();
  }
  await store.wipe();
  return { kind: "wiped", uploaded: before - lost };
}
