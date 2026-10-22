/**
 * The outbox: scans a phone decided on its own, kept in IndexedDB until a server acknowledges
 * them. Uploaded to the hub first, else the VM (the same hub-first routing as a claim), in batches
 * of up to 500. A scan leaves the outbox only when the server names its `scan_id` in the
 * acknowledgement; uploads are idempotent on that id, so a lost response just repeats the batch.
 */
import { NetworkError } from "./client";
import { RoutedClient, type Clients, type Link } from "./routes";
import type { ScannerStore } from "./types";

const BATCH = 200;
/** One drain pass looks at most this many scans deep. */
const MAX_PASS = 5000;

export interface DrainResult {
  sent: number;
  remaining: number;
  /** Which server took the scans, or null when none did. */
  link: Link | null;
  /** Scans that the server flagged as conflicts. */
  conflicts: string[];
}

export async function drainOutbox(store: ScannerStore, clients: Clients): Promise<DrainResult> {
  const client = new RoutedClient(clients);
  const pending = await store.outboxBatch(MAX_PASS);
  let sent = 0;
  let link: Link | null = null;
  const conflicts: string[] = [];
  try {
    // A scan the server does not acknowledge (a ticket it has not heard of yet) simply stays
    // queued for the next pass; the others are not held up behind it.
    for (let i = 0; i < pending.length; i += BATCH) {
      const res = await client.uploadScans(pending.slice(i, i + BATCH));
      link = client.route;
      await store.ackOutbox(res.acknowledged);
      sent += res.acknowledged.length;
      conflicts.push(...res.conflicts);
    }
  } catch (err) {
    // Not reachable: everything stays queued. Auth errors reach the caller (revocation).
    if (!(err instanceof NetworkError)) throw err;
  }
  return { sent, remaining: await store.outboxCount(), link, conflicts };
}
