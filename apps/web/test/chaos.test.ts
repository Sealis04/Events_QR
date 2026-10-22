/**
 * M5 chaos test (plan: "5,000 scans with random hub and access-point cuts reconcile and every
 * conflict is flagged"). A real VM (MariaDB, real route handlers), a real hub (SQLite, real
 * handlers) and 20 phones running the real offline pipeline, outbox and background cycle. Phones
 * keep scanning while links drop and come back at random: a phone can lose the hub (it falls back
 * to the VM), lose the whole access point (it decides alone and queues), and the hub's own uplink
 * dies and returns. At the end every link is restored and everything reconciles.
 *
 * Asserted against an independent replay of the scans, not against the code under test:
 *   - every scan reaches the VM (and the hub) exactly once;
 *   - final `admits_used` / `inside` of every ticket equal the replay of all its scans;
 *   - every double admission is flagged as a conflict (on the later one by `scanned_at`) and no
 *     other scan is flagged, on the VM and on the hub alike.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { POST as vmClaim } from "../src/app/api/claim/route";
import { POST as vmExit } from "../src/app/api/exit/route";
import { GET as vmSync } from "../src/app/api/sync/route";
import { POST as phoneScans } from "../src/app/api/scans/route";
import { GET as vmHealth } from "../src/app/api/health/route";
import { syncCycle } from "../src/scanner/cycle";
import { MemoryStore } from "../src/scanner/memoryStore";
import { processScan, type PipelineDeps } from "../src/scanner/pipeline";
import { clientsFor, RoutedClient } from "../src/scanner/routes";
import type { DeviceRecord, OutboxScan, SyncTicket } from "../src/scanner/types";
import * as hubRoutes from "../src/hub/routes";
import { pendingScanCount } from "../src/hub/vmsync";
import { call, createTestEnv, dbAvailable, newKey, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

const PHONES = 20;
const SCANS = 5000;
const SEED = Number(process.env.CHAOS_SEED ?? 20261022);

/** Small seeded PRNG so a failing run can be replayed (CHAOS_SEED=...). */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Link = "both" | "cloud" | "none";
interface Phone {
  n: number;
  store: RecordingStore;
  device: DeviceRecord;
  link: Link;
  deps: PipelineDeps;
}

/** A store that remembers every scan the phone queued (the ground truth for "decided offline"). */
class RecordingStore extends MemoryStore {
  decided: OutboxScan[] = [];
  override async commitOffline(ticket: SyncTicket, scan: OutboxScan) {
    this.decided.push(structuredClone(scan));
    return super.commitOffline(ticket, scan);
  }
}

interface Row {
  id: string;
  direction: string;
  result: string;
  scannedAt: number;
  offline: boolean;
  conflict: boolean;
  deviceId: string | null;
}

/** The rules, written out again for the check: entries, exits, the limit, "later one is the double". */
function replay(rows: Row[], max: number | null) {
  const sorted = rows
    .filter((r) => ["admitted", "override", "exited"].includes(r.result))
    .sort((a, b) => a.scannedAt - b.scannedAt || (a.id < b.id ? -1 : 1));
  let admits = 0;
  let inside = false;
  const doubles = new Set<string>();
  for (const r of sorted) {
    if (r.result === "exited") inside = false;
    else if (r.direction === "entry") {
      if (inside || (max !== null && admits >= max)) doubles.add(r.id);
      admits += 1;
      inside = true;
    }
  }
  return { admits, inside, doubles };
}

describe.skipIf(!dbAvailable)(
  "chaos: 5,000 scans, 20 phones, random hub and access-point cuts",
  () => {
    let env: TestEnv;
    let w: HubWorld;

    beforeAll(async () => {
      env = await createTestEnv();
      w = await createHubWorld(env);
    });
    afterAll(async () => {
      await w.close();
      await env.close();
    });

    it("reconciles: each scan on the VM exactly once, final state equals the replay, every conflict flagged", async () => {
      const rand = mulberry32(SEED);
      const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;

      // Tickets: single-entry, limited (3) and unlimited.
      const tickets: { id: string; token: string; type: number }[] = [];
      for (const [type, quantity] of [
        [0, 500],
        [1, 300],
        [2, 200],
      ] as const) {
        const res = await call(generate, {
          staff: w.staff,
          params: { id: String(w.eventId) },
          body: { idempotency_key: newKey(), ticket_type: type, quantity },
        });
        expect(res.status).toBe(201);
        for (const t of res.json.tickets) tickets.push({ id: t.ticket_id, token: t.token, type });
      }
      await w.pull();

      // Phones: half enrolled at the hub, half at the VM.
      const state = { hubDown: false };
      const expected = new Set<string>(); // ids of every scan a server or a phone recorded
      const offlineIds = new Set<string>();
      const hubHandlers: Record<string, (req: Request) => Promise<Response>> = {
        "POST /api/claim": hubRoutes.claim,
        "POST /api/exit": hubRoutes.exit,
        "GET /api/sync": hubRoutes.sync,
        "POST /api/scans": hubRoutes.scans,
      };
      type VmHandler = (
        req: Request,
        ctx: { params: Promise<Record<string, string>> },
      ) => Promise<Response>;
      const vmHandlers: Record<string, VmHandler> = {
        "POST /api/claim": vmClaim,
        "POST /api/exit": vmExit,
        "GET /api/sync": vmSync,
        "POST /api/scans": phoneScans,
        "GET /api/health": vmHealth,
      };

      const phones: Phone[] = [];
      const fetchFor = (phone: () => Phone): typeof fetch =>
        (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(typeof input === "string" ? input : input.toString());
          const p = phone();
          const isHub = url.host === "hub.test";
          if (p.link === "none" || (isHub && (p.link === "cloud" || state.hubDown)))
            throw new TypeError("fetch failed");
          const key = `${init?.method ?? "GET"} ${url.pathname}`;
          const req = new Request(url, { ...init, signal: undefined });
          const res = isHub
            ? await hubHandlers[key]!(req)
            : await vmHandlers[key]!(req, { params: Promise.resolve({}) });
          if (
            res.status === 200 &&
            (url.pathname === "/api/claim" || url.pathname === "/api/exit")
          ) {
            expected.add((JSON.parse(String(init?.body)) as { scan_id: string }).scan_id);
          }
          return res;
        }) as typeof fetch;

      for (let n = 0; n < PHONES; n++) {
        const enrolled =
          n % 2 === 0
            ? await w.enrolAtHub(n % 4 === 0 ? "Gate A" : "Gate B", "both")
            : await w.enrolAtVm(n % 4 === 1 ? "Gate A" : "Gate B", "both");
        const store = new RecordingStore();
        const device: DeviceRecord = {
          deviceId: enrolled.id,
          token: enrolled.token,
          serverUrl: n % 2 === 0 ? "http://hub.test" : "http://vm.test",
          hubUrl: "http://hub.test",
          cloudUrl: "http://vm.test",
          gate:
            n % 2 === 0 ? (n % 4 === 0 ? "Gate A" : "Gate B") : n % 4 === 1 ? "Gate A" : "Gate B",
          direction: "both",
          label: null,
          bundle: enrolled.bundle as DeviceRecord["bundle"],
          clockOffset: 0,
          cursor: null,
          cloudCursor: null,
          synced: false,
          ticketTypes: [],
        };
        await store.setDevice(device);
        const phone: Phone = {
          n,
          store,
          device,
          link: "both",
          deps: undefined as unknown as PipelineDeps,
        };
        phones.push(phone);
      }
      const clientsOf = (p: Phone) => clientsFor(p.device, { fetch: fetchFor(() => p) });
      for (const p of phones) {
        p.deps = {
          store: p.store,
          get client() {
            return new RoutedClient(clientsOf(p));
          },
          device: p.device,
          staff: { id: w.staff.id, name: "chaos", role: "staff" },
          now: () => env.clock.now,
          newId: () => crypto.randomUUID(),
        } as PipelineDeps;
      }
      const cycle = async (p: Phone) => {
        const res = await syncCycle(p.store, (await p.store.getDevice())!, {
          clients: clientsOf(p),
          nowLocal: () => env.clock.now,
        });
        if (res.kind === "ok" || res.kind === "offline") {
          p.device = res.device;
          p.deps = { ...p.deps, device: p.device } as PipelineDeps;
        }
        return res;
      };
      // First sync with everything up: all phones hold the ticket list.
      for (const p of phones) {
        await w.push();
        expect((await cycle(p)).kind).toBe("ok");
      }
      expect(await phones[0]!.store.ticketCount()).toBe(tickets.length);

      // The storm.
      let offlineDecisions = 0;
      const touched: string[] = [];
      for (let i = 0; i < SCANS; i++) {
        env.clock.now += 1;
        if (i % 40 === 0) {
          for (const p of phones) {
            const r = rand();
            p.link = r < 0.28 ? "none" : r < 0.42 ? "cloud" : "both";
          }
          state.hubDown = rand() < 0.15;
        }
        if (i % 30 === 0) {
          // The hub's uplink flaps too.
          if (rand() < 0.4) w.cutUplink();
          else w.restoreUplink();
          if (rand() < 0.7) await w.pull().catch(() => undefined);
          await w.push().catch(() => undefined);
        }
        if (i % 12 === 0) await cycle(pick(phones)).catch(() => undefined);

        const p = pick(phones);
        // 35% of scans go to a ticket that was already scanned somewhere: the double-admit attempts.
        const again = touched.length && rand() < 0.35 ? pick(touched) : undefined;
        const t = again ? tickets.find((x) => x.id === again)! : pick(tickets);
        touched.push(t.id);
        const local = await p.store.getTicket(t.id);
        const exit = !!local && local.entry_mode !== "single" && local.inside && rand() < 0.4;
        const before = p.store.decided.length;
        await processScan(p.deps, t.token, exit ? "exit" : "entry");
        for (const s of p.store.decided.slice(before)) {
          expected.add(s.scan_id);
          offlineIds.add(s.scan_id);
          offlineDecisions += 1;
        }
      }
      expect(offlineDecisions).toBeGreaterThan(300); // the storm really did cut phones off

      // Everything comes back; reconcile until quiet.
      state.hubDown = false;
      w.restoreUplink();
      for (const p of phones) p.link = "both";
      for (let round = 0; round < 8; round++) {
        await w.push();
        for (const p of phones) await cycle(p);
        await w.push();
        await w.pull();
      }
      for (const p of phones) expect(await p.store.outboxCount()).toBe(0);
      expect(pendingScanCount(w.hub)).toBe(0);

      // ---- assertions against the independent replay ----
      const vmRows = await env.handle.db.select().from(mysqlSchema.scans);
      const hubRowsRaw = w.hub.db.select().from(sqliteSchema.scans).all();

      const vmIds = vmRows.map((r) => r.id);
      expect(new Set(vmIds).size).toBe(vmIds.length); // never twice
      expect(new Set(vmIds)).toEqual(expected); // and none missing or invented
      expect(new Set(hubRowsRaw.map((r) => r.id))).toEqual(expected);
      for (const id of offlineIds) expect(vmIds).toContain(id);

      const byTicket = (rows: { ticketId: Uint8Array | Buffer }[]) => {
        const m = new Map<string, number[]>();
        rows.forEach((r, i) => {
          const k = bytesToHex(new Uint8Array(r.ticketId));
          m.set(k, [...(m.get(k) ?? []), i]);
        });
        return m;
      };
      const toRow = (r: (typeof vmRows)[number] | (typeof hubRowsRaw)[number]): Row => ({
        id: r.id,
        direction: r.direction,
        result: r.result,
        scannedAt: r.scannedAt,
        offline: r.offline,
        conflict: !!r.conflict,
        deviceId: r.deviceId,
      });

      const vmTickets = await env.handle.db.select().from(mysqlSchema.tickets);
      const hubTickets = w.hub.db.select().from(sqliteSchema.tickets).all();
      const vmByTicket = byTicket(vmRows);
      const hubByTicket = byTicket(hubRowsRaw);
      let doubles = 0;
      let doublesWithOffline = 0;
      for (const t of vmTickets) {
        const id = bytesToHex(new Uint8Array(t.id));
        const rows = (vmByTicket.get(id) ?? []).map((i) => toRow(vmRows[i]!));
        const want = replay(rows, t.maxAdmits);
        expect({ admits: t.admitsUsed, inside: t.inside }, `VM ticket ${id}`).toEqual({
          admits: want.admits,
          inside: want.inside,
        });
        const flagged = new Set(rows.filter((r) => r.conflict).map((r) => r.id));
        expect(flagged, `VM conflicts for ${id}`).toEqual(want.doubles);
        doubles += want.doubles.size;
        if (want.doubles.size && rows.some((r) => r.offline))
          doublesWithOffline += want.doubles.size;
        // No false flags on a ticket that was only ever admitted once.
        if (want.admits <= 1) expect(flagged.size).toBe(0);

        // The hub reached the same answer.
        const hubT = hubTickets.find((h) => bytesToHex(new Uint8Array(h.id)) === id)!;
        const hubRows = (hubByTicket.get(id) ?? []).map((i) => toRow(hubRowsRaw[i]!));
        expect({ admits: hubT.admitsUsed, inside: hubT.inside }, `hub ticket ${id}`).toEqual({
          admits: want.admits,
          inside: want.inside,
        });
        expect(new Set(hubRows.filter((r) => r.conflict).map((r) => r.id))).toEqual(want.doubles);
      }
      console.info(
        `chaos seed ${SEED}: ${vmRows.length} scans (${offlineIds.size} decided offline), ` +
          `${doubles} double admissions flagged (${doublesWithOffline} on tickets with offline scans)`,
      );
      expect(doubles).toBeGreaterThan(0); // the test would be vacuous otherwise
      expect(doublesWithOffline).toBeGreaterThan(0);
      void eq;
      void hexToBytes;
    }, 600_000);
  },
);
