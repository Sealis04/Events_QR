import type { TicketStatus } from "./claim";

/** One scan row as far as replaying a ticket's history is concerned. */
export interface ReplayScan {
  id: string;
  direction: "entry" | "exit";
  result: string;
  scannedAt: number;
  /** Decided by a device with no hub or VM in reach. */
  offline: boolean;
}

export interface ReplayResult {
  admitsUsed: number;
  inside: boolean;
  status: TicketStatus;
  /** Ids of the scans to flag `conflict = true`; every other row must be cleared. */
  conflicts: Set<string>;
}

/**
 * Rebuilds a ticket's state from its scans, which must already be sorted by `(scanned_at, id)`
 * and contain only `admitted`, `override` and `exited` rows. The earlier admit stays canonical;
 * an entry while the holder is inside, or past the admit limit, is flagged. A ticket cancelled on
 * the server while a phone was offline stays admitted at that phone (it could not know about a
 * cancellation that had not synced), and an offline admit scanned at or after `cancelledAt` is
 * flagged; one scanned before the cancellation is legitimate. Depends only on the scans and the
 * ticket row, so the hub and the VM converge however batches arrive.
 */
export function replayScans(
  scans: readonly ReplayScan[],
  ticket: { maxAdmits: number | null; status: TicketStatus; cancelledAt?: number | null },
): ReplayResult {
  let admits = 0;
  let inside = false;
  const conflicts = new Set<string>();
  for (const row of scans) {
    if (row.result === "exited") {
      inside = false;
    } else if (row.direction === "entry") {
      const overLimit = ticket.maxAdmits !== null && admits >= ticket.maxAdmits;
      const afterCancel =
        row.offline &&
        ticket.status === "cancelled" &&
        ticket.cancelledAt != null &&
        row.scannedAt >= ticket.cancelledAt;
      if (inside || overLimit || afterCancel) conflicts.add(row.id);
      admits += 1;
      inside = true;
    }
  }
  const usedUp = ticket.maxAdmits !== null && admits >= ticket.maxAdmits;
  const status: TicketStatus =
    ticket.status === "cancelled" ? "cancelled" : usedUp ? "used_up" : "valid";
  return { admitsUsed: admits, inside, status, conflicts };
}
