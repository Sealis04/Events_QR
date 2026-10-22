import { newBoxKey, open as openBox, seal, type Sealed } from "./secureBox";
import { searchTicketList } from "./search";
import type { DeviceRecord, OutboxScan, ScannerStore, SyncTicket } from "./types";

const DB_NAME = "events-qr-scanner";
/** v2 (M5): every record is sealed (AES-GCM) and there is a real outbox. v1 data is dropped. */
const DB_VERSION = 2;

const STORES = ["device", "keys", "tickets", "outbox", "meta"] as const;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
      db.createObjectStore("device");
      db.createObjectStore("keys");
      db.createObjectStore("tickets", { keyPath: "id" });
      const outbox = db.createObjectStore("outbox", { keyPath: "scan_id" });
      outbox.createIndex("seq", "seq");
      db.createObjectStore("meta");
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

interface SealedRow extends Sealed {
  id: string;
}
interface OutboxRow extends Sealed {
  scan_id: string;
  seq: number;
}

/**
 * IndexedDB-backed store, encrypted at rest. Ticket and outbox ids stay in the clear (they are
 * the record keys); names, counters, the event key, the device token and the staff list are not.
 */
export class IdbStore implements ScannerStore {
  private db: Promise<IDBDatabase> | undefined;
  private keyPromise: Promise<CryptoKey> | undefined;
  private seqBase = Date.now() * 1000;

  private conn(): Promise<IDBDatabase> {
    return (this.db ??= open());
  }

  /** Closes the connection (tests simulate a reload with a second store on the same database). */
  async close(): Promise<void> {
    if (this.db) (await this.db).close();
    this.db = undefined;
    this.keyPromise = undefined;
  }

  private key(): Promise<CryptoKey> {
    return (this.keyPromise ??= (async () => {
      const db = await this.conn();
      const existing = (await done(db.transaction("keys").objectStore("keys").get("box"))) as
        CryptoKey | undefined;
      if (existing) return existing;
      const created = await newBoxKey();
      const tx = db.transaction("keys", "readwrite");
      // Two tabs racing: the first writer wins, the other re-reads.
      tx.objectStore("keys").add(created, "box");
      await finished(tx).catch(() => undefined);
      return (await done(db.transaction("keys").objectStore("keys").get("box"))) as CryptoKey;
    })());
  }

  private async sealed(aad: string, value: unknown) {
    return seal(await this.key(), aad, value);
  }
  private async opened<T>(aad: string, box: Sealed): Promise<T> {
    return openBox<T>(await this.key(), aad, box);
  }

  async getDevice() {
    const db = await this.conn();
    const row = (await done(db.transaction("device").objectStore("device").get("device"))) as
      Sealed | undefined;
    return row ? this.opened<DeviceRecord>("device", row) : undefined;
  }
  async setDevice(device: DeviceRecord) {
    const row = await this.sealed("device", device);
    const db = await this.conn();
    const tx = db.transaction("device", "readwrite");
    tx.objectStore("device").put(row, "device");
    await finished(tx);
  }
  async wipe() {
    const db = await this.conn();
    const tx = db.transaction([...STORES], "readwrite");
    for (const name of STORES) tx.objectStore(name).clear();
    await finished(tx);
    this.keyPromise = undefined;
  }
  async wipeTickets() {
    const db = await this.conn();
    const tx = db.transaction(["tickets"], "readwrite");
    tx.objectStore("tickets").clear();
    await finished(tx);
  }

  async putTickets(tickets: SyncTicket[]) {
    if (tickets.length === 0) return;
    const rows = await Promise.all(
      tickets.map(async (t) => ({ id: t.id, ...(await this.sealed(`ticket:${t.id}`, t)) })),
    );
    const db = await this.conn();
    const tx = db.transaction("tickets", "readwrite");
    const store = tx.objectStore("tickets");
    for (const row of rows) store.put(row);
    await finished(tx);
  }
  async getTicket(idHex: string) {
    const db = await this.conn();
    const row = (await done(db.transaction("tickets").objectStore("tickets").get(idHex))) as
      SealedRow | undefined;
    return row ? this.opened<SyncTicket>(`ticket:${idHex}`, row) : undefined;
  }
  async ticketCount() {
    const db = await this.conn();
    return done(db.transaction("tickets").objectStore("tickets").count());
  }
  async searchTickets(query: string, limit = 20) {
    const db = await this.conn();
    const rows = (await done(
      db.transaction("tickets").objectStore("tickets").getAll(),
    )) as SealedRow[];
    const all = await Promise.all(rows.map((r) => this.opened<SyncTicket>(`ticket:${r.id}`, r)));
    return searchTicketList(all, query, limit);
  }

  async commitOffline(ticket: SyncTicket, scan: OutboxScan) {
    const [ticketRow, scanRow] = await Promise.all([
      this.sealed(`ticket:${ticket.id}`, ticket),
      this.sealed(`outbox:${scan.scan_id}`, scan),
    ]);
    const db = await this.conn();
    const tx = db.transaction(["tickets", "outbox"], "readwrite");
    tx.objectStore("tickets").put({ id: ticket.id, ...ticketRow });
    const seq = (this.seqBase += 1);
    tx.objectStore("outbox").put({ scan_id: scan.scan_id, seq, ...scanRow } satisfies OutboxRow);
    await finished(tx);
  }
  async outboxBatch(limit = 200) {
    const db = await this.conn();
    const rows = (await done(
      db.transaction("outbox").objectStore("outbox").index("seq").getAll(null, limit),
    )) as OutboxRow[];
    return Promise.all(rows.map((r) => this.opened<OutboxScan>(`outbox:${r.scan_id}`, r)));
  }
  async outboxCount() {
    const db = await this.conn();
    return done(db.transaction("outbox").objectStore("outbox").count());
  }
  async ackOutbox(scanIds: string[]) {
    if (scanIds.length === 0) return;
    const db = await this.conn();
    const tx = db.transaction("outbox", "readwrite");
    for (const id of scanIds) tx.objectStore("outbox").delete(id);
    await finished(tx);
  }
  async pendingTicketIds() {
    const db = await this.conn();
    const rows = (await done(
      db.transaction("outbox").objectStore("outbox").getAll(),
    )) as OutboxRow[];
    const scans = await Promise.all(
      rows.map((r) => this.opened<OutboxScan>(`outbox:${r.scan_id}`, r)),
    );
    return new Set(scans.map((s) => s.ticket_id));
  }

  async getMeta<T>(key: string) {
    const db = await this.conn();
    const row = (await done(db.transaction("meta").objectStore("meta").get(key))) as
      Sealed | undefined;
    return row ? this.opened<T>(`meta:${key}`, row) : undefined;
  }
  async setMeta(key: string, value: unknown) {
    const row = await this.sealed(`meta:${key}`, value);
    const db = await this.conn();
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(row, key);
    await finished(tx);
  }
}
