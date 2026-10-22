import type { DeviceRecord, OutboxScan, ScannerStore, SyncTicket } from "./types";
import { searchTicketList } from "./search";

/** In-memory `ScannerStore` for unit tests. */
export class MemoryStore implements ScannerStore {
  device: DeviceRecord | undefined;
  tickets = new Map<string, SyncTicket>();
  outbox: OutboxScan[] = [];
  meta = new Map<string, unknown>();

  async getDevice() {
    return this.device ? structuredClone(this.device) : undefined;
  }
  async setDevice(device: DeviceRecord) {
    this.device = structuredClone(device);
  }
  async wipe() {
    this.device = undefined;
    this.tickets.clear();
    this.outbox = [];
    this.meta.clear();
  }
  async wipeTickets() {
    this.tickets.clear();
  }
  async putTickets(tickets: SyncTicket[]) {
    for (const t of tickets) this.tickets.set(t.id, { ...t });
  }
  async getTicket(idHex: string) {
    const t = this.tickets.get(idHex);
    return t ? { ...t } : undefined;
  }
  async ticketCount() {
    return this.tickets.size;
  }
  async searchTickets(query: string, limit = 20) {
    return searchTicketList([...this.tickets.values()], query, limit);
  }
  async commitOffline(ticket: SyncTicket, scan: OutboxScan) {
    this.tickets.set(ticket.id, { ...ticket });
    this.outbox.push(structuredClone(scan));
  }
  async outboxBatch(limit = 200) {
    return structuredClone(this.outbox.slice(0, limit));
  }
  async outboxCount() {
    return this.outbox.length;
  }
  async ackOutbox(scanIds: string[]) {
    const gone = new Set(scanIds);
    this.outbox = this.outbox.filter((s) => !gone.has(s.scan_id));
  }
  async pendingTicketIds() {
    return new Set(this.outbox.map((s) => s.ticket_id));
  }
  async getMeta<T>(key: string) {
    return this.meta.has(key) ? (structuredClone(this.meta.get(key)) as T) : undefined;
  }
  async setMeta(key: string, value: unknown) {
    this.meta.set(key, structuredClone(value));
  }
}
