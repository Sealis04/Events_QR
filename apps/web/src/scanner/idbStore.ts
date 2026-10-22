import type { DeviceRecord, ScannerStore, SyncTicket } from "./types";
import { searchTicketList } from "./search";

const DB_NAME = "events-qr-scanner";
const DB_VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("device");
      db.createObjectStore("tickets", { keyPath: "id" });
      db.createObjectStore("outbox", { keyPath: "scan_id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** IndexedDB-backed store: ~5,000 tickets at about 100 bytes each. */
export class IdbStore implements ScannerStore {
  private db: Promise<IDBDatabase> | undefined;
  private conn(): Promise<IDBDatabase> {
    return (this.db ??= open());
  }

  async getDevice() {
    const db = await this.conn();
    return (await done(db.transaction("device").objectStore("device").get("device"))) as
      DeviceRecord | undefined;
  }
  async setDevice(device: DeviceRecord) {
    const db = await this.conn();
    const tx = db.transaction("device", "readwrite");
    tx.objectStore("device").put(device, "device");
    await finished(tx);
  }
  async wipe() {
    const db = await this.conn();
    const tx = db.transaction(["device", "tickets", "outbox"], "readwrite");
    for (const name of ["device", "tickets", "outbox"]) tx.objectStore(name).clear();
    await finished(tx);
  }
  async putTickets(tickets: SyncTicket[]) {
    if (tickets.length === 0) return;
    const db = await this.conn();
    const tx = db.transaction("tickets", "readwrite");
    const store = tx.objectStore("tickets");
    for (const t of tickets) store.put(t);
    await finished(tx);
  }
  async getTicket(idHex: string) {
    const db = await this.conn();
    return (await done(db.transaction("tickets").objectStore("tickets").get(idHex))) as
      SyncTicket | undefined;
  }
  async ticketCount() {
    const db = await this.conn();
    return done(db.transaction("tickets").objectStore("tickets").count());
  }
  async searchTickets(query: string, limit = 20) {
    const db = await this.conn();
    const all = (await done(
      db.transaction("tickets").objectStore("tickets").getAll(),
    )) as SyncTicket[];
    return searchTicketList(all, query, limit);
  }
  async outboxCount() {
    const db = await this.conn();
    return done(db.transaction("outbox").objectStore("outbox").count());
  }
}
