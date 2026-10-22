import type { SyncTicket } from "./types";

/** Manual search: name substring, or the last hex characters printed under the QR. */
export function searchTicketList(tickets: Iterable<SyncTicket>, query: string, limit: number) {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const hex = /^[0-9a-f]+$/.test(q);
  const out: SyncTicket[] = [];
  for (const t of tickets) {
    if (t.id.endsWith(q) && hex) out.push(t);
    else if (t.holder_name?.toLowerCase().includes(q)) out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}
