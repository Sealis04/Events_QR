import type { DeviceRecord, ScannerStore, SyncTicket } from "./types";
import { searchTicketList } from "./search";

/** In-memory `ScannerStore` for unit tests. */
export class MemoryStore implements ScannerStore {
  device: DeviceRecord | undefined;
  tickets = new Map<string, SyncTicket>();
  outbox: unknown[] = [];

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
  async outboxCount() {
    return this.outbox.length;
  }
}
