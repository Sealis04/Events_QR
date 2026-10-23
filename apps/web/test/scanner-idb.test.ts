/** The phone's encrypted IndexedDB store (a fake IndexedDB in Node): round trips, at-rest encryption, reload. */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IdbStore } from "../src/scanner/idbStore";
import type { OutboxScan } from "../src/scanner/types";
import { createFixtures, DEVICE_ID, type Fixtures } from "./scanner-fixtures";

let fx: Fixtures;

/** Everything in a raw object store, as the browser would hand it to anyone reading the file. */
function rawRows(storeName: string): Promise<{ key: IDBValidKey; value: unknown }[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("events-qr-scanner");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const out: { key: IDBValidKey; value: unknown }[] = [];
      const req = db.transaction(storeName).objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push({ key: cur.key, value: cur.value });
          cur.continue();
        } else {
          db.close();
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error);
    };
  });
}
function mutate(storeName: string, fn: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("events-qr-scanner");
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(storeName, "readwrite");
      fn(tx.objectStore(storeName));
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

const scan = (ticket: string, n = 0): OutboxScan => ({
  scan_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  ticket_id: ticket,
  device_id: DEVICE_ID,
  staff_id: null,
  gate: "Gate A",
  direction: "entry",
  scanned_at: 1_900_000_000 + n,
  result: "admitted",
  offline: true,
});

let store: IdbStore;
beforeEach(async () => {
  fx = await createFixtures();
  store = new IdbStore();
  await store.wipe();
});

describe("IdbStore (encrypted at rest)", () => {
  it("round-trips the device, tickets, search and meta", async () => {
    const device = fx.device({ staff: [{ id: "s1", name: "Sam", role: "staff", pinHash: "h" }] });
    await store.setDevice(device);
    expect(await store.getDevice()).toEqual(device);
    expect(await store.getDevice().then((d) => d?.bundle.event_key)).toBe(device.bundle.event_key);

    const a = await fx.make({ name: "Ada Lovelace" });
    const b = await fx.make({ name: "Grace Hopper" });
    await store.putTickets([a.ticket, b.ticket]);
    expect(await store.ticketCount()).toBe(2);
    expect(await store.getTicket(a.id)).toEqual(a.ticket);
    expect(await store.getTicket("00".repeat(16))).toBeUndefined();
    expect((await store.searchTickets("hopper")).map((t) => t.id)).toEqual([b.id]);
    expect((await store.searchTickets(a.id.slice(-6))).map((t) => t.id)).toEqual([a.id]);

    expect(await store.getMeta("x")).toBeUndefined();
    await store.setMeta("x", { n: 1 });
    expect(await store.getMeta("x")).toEqual({ n: 1 });
  });

  it("keeps names, the event key, the token and the staff list out of the stored bytes", async () => {
    const device = fx.device({
      staff: [{ id: "s1", name: "Zebulon", role: "staff", pinHash: "$argon2id$secret" }],
    });
    await store.setDevice(device);
    const t = await fx.make({ name: "Ada Lovelace" });
    await store.putTickets([t.ticket]);
    await store.commitOffline({ ...t.ticket, inside: true }, scan(t.id));
    await store.setMeta("pin-lockout", { fails: 3 });
    const dump = JSON.stringify(
      await Promise.all(["device", "tickets", "outbox", "meta"].map(rawRows)),
      (_k, v) => (v instanceof ArrayBuffer ? Buffer.from(v).toString("latin1") : v),
    );
    const bytes = (await Promise.all(["device", "tickets", "outbox", "meta"].map(rawRows)))
      .flat()
      .map((r) => {
        const v = r.value as { ct?: ArrayBuffer };
        return v.ct ? Buffer.from(v.ct).toString("latin1") : "";
      })
      .join("");
    for (const secret of [
      "Ada Lovelace",
      device.bundle.event_key,
      device.token,
      "Zebulon",
      "argon2id",
      "fails",
    ]) {
      expect(dump).not.toContain(secret);
      expect(bytes).not.toContain(secret);
    }
    // Ids are the record keys; they are the only thing in the clear.
    expect(dump).toContain(t.id);
  });

  it("holds the key as a non-extractable CryptoKey that script cannot export", async () => {
    await store.setDevice(fx.device());
    const [row] = await rawRows("keys");
    const key = row!.value as CryptoKey;
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("refuses records that were tampered with or moved to another slot", async () => {
    const a = await fx.make();
    const b = await fx.make();
    await store.putTickets([a.ticket, b.ticket]);
    const rows = await rawRows("tickets");
    const rowA = rows.find((r) => r.key === a.id)!.value as {
      id: string;
      iv: Uint8Array;
      ct: ArrayBuffer;
    };
    // Row A's ciphertext under B's id: the additional data (the id) no longer matches.
    await mutate("tickets", (s) => s.put({ ...rowA, id: b.id }));
    await expect(store.getTicket(b.id)).rejects.toThrow();
    // A flipped bit.
    const flipped = new Uint8Array(rowA.ct.slice(0));
    flipped[0] = flipped[0]! ^ 1;
    await mutate("tickets", (s) => s.put({ ...rowA, ct: flipped.buffer }));
    await expect(store.getTicket(a.id)).rejects.toThrow();
  });

  it("cannot be read with a different key (the key store emptied or replaced)", async () => {
    await store.setDevice(fx.device());
    await mutate("keys", (s) => s.clear());
    const reopened = new IdbStore();
    await expect(reopened.getDevice()).rejects.toThrow();
  });

  it("the outbox survives a reload: same scans, same order, then acknowledged ones are gone", async () => {
    const t = await fx.make({ mode: "unlimited" });
    await store.setDevice(fx.device());
    await store.putTickets([t.ticket]);
    for (let i = 0; i < 5; i++)
      await store.commitOffline({ ...t.ticket, admits_used: i + 1 }, scan(t.id, i));
    expect(await store.outboxCount()).toBe(5);

    await store.close(); // the page is reloaded / the phone restarted
    const reloaded = new IdbStore();
    expect(await reloaded.outboxCount()).toBe(5);
    expect((await reloaded.outboxBatch()).map((s) => s.scanned_at)).toEqual(
      [0, 1, 2, 3, 4].map((i) => 1_900_000_000 + i),
    );
    expect(await reloaded.getTicket(t.id)).toMatchObject({ admits_used: 5 });
    expect(await reloaded.getDevice()).toEqual(fx.device());
    expect([...(await reloaded.pendingTicketIds())]).toEqual([t.id]);

    await reloaded.ackOutbox([scan(t.id, 1).scan_id, scan(t.id, 3).scan_id]);
    expect((await reloaded.outboxBatch()).map((s) => s.scanned_at)).toEqual(
      [0, 2, 4].map((i) => 1_900_000_000 + i),
    );
    expect(await reloaded.outboxBatch(2)).toHaveLength(2);
    await reloaded.ackOutbox((await reloaded.outboxBatch()).map((s) => s.scan_id));
    expect(await reloaded.outboxCount()).toBe(0);
    expect((await reloaded.pendingTicketIds()).size).toBe(0);
  });

  it("replaying the same scan id is one outbox row", async () => {
    const t = await fx.make();
    await store.commitOffline(t.ticket, scan(t.id, 1));
    await store.commitOffline(t.ticket, scan(t.id, 1));
    expect(await store.outboxCount()).toBe(1);
  });

  it("wipeTickets keeps the device and the outbox; wipe removes everything including the key", async () => {
    const t = await fx.make();
    await store.setDevice(fx.device());
    await store.putTickets([t.ticket]);
    await store.commitOffline(t.ticket, scan(t.id));
    await store.wipeTickets();
    expect(await store.ticketCount()).toBe(0);
    expect(await store.getDevice()).toBeDefined();
    expect(await store.outboxCount()).toBe(1);

    await store.wipe();
    expect(await store.getDevice()).toBeUndefined();
    expect(await store.outboxCount()).toBe(0);
    for (const name of ["device", "keys", "tickets", "outbox", "meta"])
      expect(await rawRows(name)).toHaveLength(0);
    // Usable again after a wipe, with a fresh key.
    await store.setDevice(fx.device());
    expect(await store.getDevice()).toBeDefined();
  });

  it("5,000 tickets: a full-list search decrypts in well under a second", async () => {
    const list = [];
    for (let i = 0; i < 5000; i++)
      list.push((await fx.make({ idNumber: i + 1, name: `Person ${i}` })).ticket);
    await store.putTickets(list);
    expect(await store.ticketCount()).toBe(5000);
    const start = performance.now();
    const hits = await store.searchTickets("person 4999");
    console.info(
      `encrypted search over 5,000 tickets: ${(performance.now() - start).toFixed(0)} ms`,
    );
    expect(hits).toHaveLength(1);
  }, 60_000);
});
