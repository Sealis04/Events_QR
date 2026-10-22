/**
 * The phone deciding alone (M5): every result state with the hub and the VM both unreachable, the
 * outbox it fills, and how it is uploaded, merged with a sync and wiped.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { ApiRejected, AuthError, NetworkError, type HubClient } from "../src/scanner/client";
import { syncCycle } from "../src/scanner/cycle";
import { MemoryStore } from "../src/scanner/memoryStore";
import { drainOutbox } from "../src/scanner/outbox";
import { manualExit, overrideAdmit, processScan, type PipelineDeps } from "../src/scanner/pipeline";
import { resultView } from "../src/scanner/result";
import { clientsFor, RoutedClient } from "../src/scanner/routes";
import { syncAll } from "../src/scanner/sync";
import type { DeviceRecord, SyncTicket } from "../src/scanner/types";
import {
  createFixtures,
  DAY_ZERO,
  DEVICE_ID,
  NOW,
  STAFF,
  SUPERVISOR,
  type Fixtures,
  type Made,
} from "./scanner-fixtures";

let fx: Fixtures;
beforeAll(async () => {
  fx = await createFixtures();
});

/** A client for which every call is a dead network. */
const dead: HubClient = {
  claim: async () => Promise.reject(new NetworkError("down")),
  exit: async () => Promise.reject(new NetworkError("down")),
  sync: async () => Promise.reject(new NetworkError("down")),
  uploadScans: async () => Promise.reject(new NetworkError("down")),
  health: async () => Promise.reject(new NetworkError("down")),
};

interface Rig {
  store: MemoryStore;
  device: DeviceRecord;
  deps: PipelineDeps;
  clock: { now: number };
  known(m: Made): Promise<Made>;
}
function rig(over: Partial<DeviceRecord> = {}): Rig {
  const store = new MemoryStore();
  const device = fx.device(over);
  const clock = { now: NOW };
  const deps: PipelineDeps = {
    store,
    client: dead,
    device,
    staff: STAFF,
    now: () => clock.now,
    newId: () => crypto.randomUUID(),
  };
  return {
    store,
    device,
    deps,
    clock,
    known: async (m) => {
      await store.putTickets([m.ticket]);
      return m;
    },
  };
}

describe("offline entry: every result state", () => {
  it("green with the OFFLINE banner, then 'Already inside (offline)' for a single-entry ticket", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ name: "Ada" }));
    const first = await processScan(r.deps, t.token, "entry");
    expect(first).toMatchObject({ kind: "admitted", name: "Ada", offline: true, entry: null });
    expect(resultView(first)).toMatchObject({
      tone: "green",
      title: "Ada",
      banner: "OFFLINE",
      dismissMs: 1500,
    });
    expect(await r.store.getTicket(t.id)).toMatchObject({
      inside: true,
      admits_used: 1,
      status: "used_up",
    });

    const again = await processScan(r.deps, t.token, "entry");
    expect(again).toMatchObject({ kind: "inside", offline: true });
    expect(resultView(again)).toMatchObject({
      tone: "red",
      title: "Already inside (offline)",
      banner: "OFFLINE",
      dismissMs: null,
    });
    // The refusal changes nothing and queues nothing; the admit is the one queued scan.
    expect(await r.store.outboxCount()).toBe(1);
    expect(await r.store.getTicket(t.id)).toMatchObject({ inside: true, admits_used: 1 });
  });

  it("limited re-entry: entries count up, exits free the ticket, and 'No entries left (offline)' at the limit", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ mode: "limited", max: 2, name: "Lee" }));
    expect(await processScan(r.deps, t.token, "entry")).toMatchObject({
      kind: "admitted",
      entry: 1,
      of: 2,
    });
    expect(await processScan(r.deps, t.token, "entry")).toMatchObject({ kind: "inside" });
    const out = await processScan(r.deps, t.token, "exit");
    expect(out).toMatchObject({ kind: "exited", offline: true, entriesLeft: 1 });
    expect(resultView(out)).toMatchObject({
      tone: "blue",
      title: "Exit recorded",
      banner: "OFFLINE",
    });
    expect(await processScan(r.deps, t.token, "entry")).toMatchObject({
      kind: "admitted",
      entry: 2,
      of: 2,
    });
    await processScan(r.deps, t.token, "exit");
    const spent = await processScan(r.deps, t.token, "entry");
    expect(spent).toMatchObject({ kind: "used", offline: true });
    expect(resultView(spent).title).toBe("No entries left (offline)");
    const queue = await r.store.outboxBatch();
    expect(queue.map((s) => [s.direction, s.result, s.offline])).toEqual([
      ["entry", "admitted", true],
      ["exit", "exited", true],
      ["entry", "admitted", true],
      ["exit", "exited", true],
    ]);
  });

  it("unlimited tickets come and go; an exit of a ticket that is not inside is still logged", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ mode: "unlimited" }));
    expect(await processScan(r.deps, t.token, "exit")).toMatchObject({
      kind: "exited",
      entriesLeft: null,
    });
    for (let i = 0; i < 3; i++) {
      expect((await processScan(r.deps, t.token, "entry")).kind).toBe("admitted");
      expect((await processScan(r.deps, t.token, "exit")).kind).toBe("exited");
    }
    expect(await r.store.outboxCount()).toBe(7);
  });

  it("grey for exit on a single-entry ticket, and nothing is queued", async () => {
    const r = rig();
    const t = await r.known(await fx.make());
    expect(await processScan(r.deps, t.token, "exit")).toMatchObject({ kind: "no_reentry" });
    expect(await r.store.outboxCount()).toBe(0);
  });

  it("red for a cancelled ticket; a cancellation the phone has not heard of is not known", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ status: "cancelled", name: "Gone" }));
    expect(await processScan(r.deps, t.token, "entry")).toEqual({
      kind: "cancelled",
      name: "Gone",
    });
    expect(await processScan(r.deps, t.token, "exit")).toEqual({ kind: "cancelled", name: "Gone" });
    expect(await r.store.outboxCount()).toBe(0);
  });

  it("the signed gate and slot checks still apply offline", async () => {
    const r = rig();
    const wrongGate = await r.known(await fx.make({ gateMask: 0b100 }));
    expect(await processScan(r.deps, wrongGate.token, "entry")).toMatchObject({
      kind: "wrong_gate",
      allowedGates: ["VIP door"],
    });
    const early = await r.known(await fx.make({ slot: [14 * 60, 16 * 60] }));
    expect((await processScan(r.deps, early.token, "entry")).kind).toBe("too_early");
    const over = await r.known(await fx.make({ slot: [8 * 60, 10 * 60] }));
    expect((await processScan(r.deps, over.token, "entry")).kind).toBe("slot_ended");
    expect(await r.store.outboxCount()).toBe(0);
  });

  it("the other red states need no network at all", async () => {
    const r = rig();
    expect(await processScan(r.deps, "hello", "entry")).toEqual({ kind: "not_ticket" });
    const t = await fx.make();
    expect(await processScan(r.deps, t.token.slice(0, -2) + "AA", "entry")).toMatchObject({
      kind: "invalid",
    });
  });

  it("amber for a ticket not in the list; a supervisor admits it offline from the signed QR and a rescan is 'inside'", async () => {
    const r = rig();
    const fresh = await fx.make({ mode: "limited", max: 3 });
    const amber = await processScan(r.deps, fresh.token, "entry");
    expect(amber).toMatchObject({ kind: "unknown_ticket", typeName: "GA" });
    const view = resultView(amber);
    expect(view.override?.stub).toMatchObject({ entry_mode: "limited", max_admits: 3 });

    const done = await overrideAdmit(
      r.deps,
      fresh.id,
      "GA",
      SUPERVISOR,
      undefined,
      view.override!.stub,
    );
    expect(done).toMatchObject({
      kind: "admitted",
      override: true,
      offline: true,
      entry: 1,
      of: 3,
    });
    expect(await r.store.outboxBatch()).toMatchObject([
      { ticket_id: fresh.id, result: "override", staff_id: SUPERVISOR.id, offline: true },
    ]);
    // The ticket is now in the phone's list, so a second scan is decided locally.
    expect(await processScan(r.deps, fresh.token, "entry")).toMatchObject({ kind: "inside" });
    // Without the stub (nothing to go on) the override fails closed.
    const other = await fx.make();
    expect((await overrideAdmit(r.deps, other.id, "GA", SUPERVISOR)).kind).toBe("no_connection");
  });

  it("manual exit from the search list also works offline", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ mode: "unlimited" }));
    await processScan(r.deps, t.token, "entry");
    const local = (await r.store.getTicket(t.id))!;
    expect(await manualExit(r.deps, local)).toMatchObject({ kind: "exited", offline: true });
    expect(await r.store.getTicket(t.id)).toMatchObject({ inside: false });
  });

  it("the per-event 'offline devices admit only tickets allowed at this gate' switch", async () => {
    const r = rig({ offlineGateOnly: true });
    const anywhere = await r.known(await fx.make());
    const restricted = await r.known(await fx.make({ gateMask: 0b001 })); // Gate A only
    const out = await processScan(r.deps, anywhere.token, "entry");
    expect(out).toEqual({ kind: "offline_restricted" });
    expect(resultView(out)).toMatchObject({ tone: "red", banner: "OFFLINE" });
    expect((await processScan(r.deps, restricted.token, "entry")).kind).toBe("admitted");
    // Online, and for exits, the switch changes nothing.
    expect((await processScan(r.deps, anywhere.token, "exit")).kind).toBe("no_reentry");
    // A supervisor can still override.
    const sup = await overrideAdmit(r.deps, anywhere.id, "GA", SUPERVISOR, anywhere.ticket);
    expect(sup).toMatchObject({ kind: "admitted", override: true });
  });

  it("retries the network on every scan: a link that comes back is used at once", async () => {
    const r = rig();
    const t = await r.known(await fx.make({ mode: "unlimited" }));
    let up = false;
    const flaky: HubClient = {
      ...dead,
      claim: async (b) => {
        if (!up) throw new NetworkError("down");
        return { result: "admitted", admits_used: 9, limit: null, ...(b ? {} : {}) };
      },
    };
    const deps = { ...r.deps, client: flaky };
    expect(await processScan(deps, t.token, "entry")).toMatchObject({ offline: true });
    await processScan(deps, t.token, "exit");
    up = true;
    const live = await processScan(deps, t.token, "entry");
    expect(live).toMatchObject({ kind: "admitted", entry: 9 });
    expect((live as { offline?: boolean }).offline).toBeUndefined();
  });

  it("an auth error is not an offline decision", async () => {
    const r = rig();
    const t = await r.known(await fx.make());
    const revoked: HubClient = { ...dead, claim: async () => Promise.reject(new AuthError("no")) };
    await expect(
      processScan({ ...r.deps, client: revoked }, t.token, "entry"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(await r.store.outboxCount()).toBe(0);
  });
});

/** Fetch stub for the two servers. */
function servers(opts: { hub?: "down" | "up"; vm?: "down" | "up" } = {}) {
  const state = { hub: opts.hub ?? "down", vm: opts.vm ?? "up" };
  const received: { server: "hub" | "vm"; scans: { scan_id: string }[] }[] = [];
  const seen = new Set<string>();
  const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const server = url.host === "hub.test" ? "hub" : "vm";
    if (state[server] === "down") throw new TypeError("fetch failed");
    if (url.pathname === "/api/scans") {
      const body = JSON.parse(String(init?.body)) as { scans: { scan_id: string }[] };
      received.push({ server, scans: body.scans });
      const fresh = body.scans.filter((s) => !seen.has(s.scan_id));
      for (const s of body.scans) seen.add(s.scan_id);
      void fresh;
      return Response.json({ acknowledged: body.scans.map((s) => s.scan_id), conflicts: [] });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { state, received, doFetch };
}

describe("the outbox", () => {
  async function filled(n: number) {
    const r = rig();
    for (let i = 0; i < n; i++) {
      const t = await r.known(await fx.make({ idNumber: i + 1 }));
      await processScan(r.deps, t.token, "entry");
    }
    return r;
  }

  it("uploads to the hub first; else to the VM; acknowledged scans leave the outbox", async () => {
    const r = await filled(3);
    const s = servers({ hub: "down", vm: "up" });
    const clients = clientsFor(r.device, { fetch: s.doFetch });
    const res = await drainOutbox(r.store, clients);
    expect(res).toMatchObject({ sent: 3, remaining: 0, link: "cloud" });
    expect(s.received.map((x) => x.server)).toEqual(["vm"]);

    const more = await filled(2);
    const s2 = servers({ hub: "up", vm: "up" });
    expect(
      await drainOutbox(more.store, clientsFor(more.device, { fetch: s2.doFetch })),
    ).toMatchObject({
      sent: 2,
      link: "hub",
    });
    expect(s2.received.map((x) => x.server)).toEqual(["hub"]);
  });

  it("keeps everything while no server answers, and the count survives for the pill", async () => {
    const r = await filled(4);
    const s = servers({ hub: "down", vm: "down" });
    const res = await drainOutbox(r.store, clientsFor(r.device, { fetch: s.doFetch }));
    expect(res).toMatchObject({ sent: 0, remaining: 4, link: null });
    expect(await r.store.outboxCount()).toBe(4);
  });

  it("sends 500+ scans in several batches, in the order they were made", async () => {
    const r = await filled(450);
    const s = servers({ hub: "down" });
    const res = await drainOutbox(r.store, clientsFor(r.device, { fetch: s.doFetch }));
    expect(res.sent).toBe(450);
    expect(s.received.length).toBe(3); // 200 + 200 + 50
    expect(s.received[0]!.scans).toHaveLength(200);
  });

  it("a scan the server does not acknowledge stays queued without blocking the rest", async () => {
    const r = await filled(3);
    const first = (await r.store.outboxBatch(1))[0]!;
    const doFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.host === "hub.test") throw new TypeError("down");
      const body = JSON.parse(String(init?.body)) as { scans: { scan_id: string }[] };
      return Response.json({
        acknowledged: body.scans.map((s) => s.scan_id).filter((id) => id !== first.scan_id),
        conflicts: [],
      });
    }) as typeof fetch;
    const res = await drainOutbox(r.store, clientsFor(r.device, { fetch: doFetch }));
    expect(res).toMatchObject({ sent: 2, remaining: 1 });
    expect((await r.store.outboxBatch())[0]!.scan_id).toBe(first.scan_id);
  });

  it("a 401 from the server it enrolled at reaches the caller (revocation)", async () => {
    const r = await filled(1);
    const doFetch = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    await expect(
      drainOutbox(r.store, clientsFor(r.device, { fetch: doFetch })),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("RoutedClient.uploadScans follows the hub, then the VM, like a claim", async () => {
    const r = await filled(1);
    const s = servers({ hub: "down", vm: "up" });
    const routed = new RoutedClient(clientsFor(r.device, { fetch: s.doFetch }));
    await routed.uploadScans(await r.store.outboxBatch());
    expect(routed.route).toBe("cloud");
  });
});

describe("a sync never rolls back what the phone decided offline and has not uploaded", () => {
  it("keeps the local inside flag and the larger admit counter for tickets with queued scans", async () => {
    const r = rig();
    const a = await r.known(await fx.make({ mode: "unlimited" }));
    const b = await r.known(await fx.make({ mode: "unlimited" }));
    await processScan(r.deps, a.token, "entry"); // queued
    await r.store.setDevice(r.device);
    const stale: SyncTicket[] = [
      { ...a.ticket, inside: false, admits_used: 0, updated_at: 50 },
      { ...b.ticket, inside: true, admits_used: 4, updated_at: 50 },
    ];
    const client: HubClient = {
      ...dead,
      sync: async () => ({
        tickets: stale,
        devices: [{ id: DEVICE_ID, gate: "Gate A", direction: "both", revoked: false }],
        ticket_types: [{ idx: 0, name: "GA", early_entry_min: 15 }],
        staff: [],
        settings: { offline_gate_only: false },
        next_cursor: "50:" + "ab".repeat(16),
        has_more: false,
        hub_time: NOW,
      }),
    };
    await syncAll(r.store, client);
    expect(await r.store.getTicket(a.id)).toMatchObject({ inside: true, admits_used: 1 });
    // No queued scan for b: the server's word is taken as it is.
    expect(await r.store.getTicket(b.id)).toMatchObject({ inside: true, admits_used: 4 });
  });

  it("a cancellation still wins over local state, and staff and settings come with the sync", async () => {
    const r = rig();
    const a = await r.known(await fx.make({ mode: "unlimited" }));
    await processScan(r.deps, a.token, "entry");
    await r.store.setDevice(r.device);
    const client: HubClient = {
      ...dead,
      sync: async () => ({
        tickets: [{ ...a.ticket, status: "cancelled", updated_at: 60 }],
        devices: [{ id: DEVICE_ID, gate: "Gate A", direction: "both", revoked: false }],
        ticket_types: [],
        staff: [{ id: STAFF.id, name: "Sam", role: "staff", pin_hash: "$argon2id$x" }],
        settings: { offline_gate_only: true },
        next_cursor: null,
        has_more: false,
        hub_time: NOW,
      }),
    };
    const device = await syncAll(r.store, client);
    expect((await r.store.getTicket(a.id))!.status).toBe("cancelled");
    expect(device.staff).toEqual([
      { id: STAFF.id, name: "Sam", role: "staff", pinHash: "$argon2id$x" },
    ]);
    expect(device.offlineGateOnly).toBe(true);
  });
});

describe("the background cycle: upload first, revocation and end-of-event wipes", () => {
  function cycleRig(opts: {
    vm?: "up" | "down";
    sync?: "ok" | "revoked" | "down";
    upload?: "ok" | "revoked" | "down";
    hubTime?: number;
  }) {
    const calls: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.host === "hub.test") throw new TypeError("down");
      calls.push(url.pathname);
      const mode = url.pathname === "/api/scans" ? opts.upload : opts.sync;
      if (mode === "revoked") return new Response("{}", { status: 401 });
      if (mode === "down") throw new TypeError("down");
      if (url.pathname === "/api/scans")
        return Response.json({ acknowledged: JSON.parse("[]"), conflicts: [] });
      return Response.json({
        tickets: [],
        devices: [{ id: DEVICE_ID, gate: "Gate A", direction: "both", revoked: false }],
        ticket_types: [],
        staff: [],
        settings: { offline_gate_only: false },
        next_cursor: null,
        has_more: false,
        hub_time: opts.hubTime ?? NOW,
      });
    }) as typeof fetch;
    return { calls, doFetch };
  }

  it("uploads the outbox before it pulls, and reports offline when nothing answers", async () => {
    const r = rig();
    const t = await r.known(await fx.make());
    await processScan(r.deps, t.token, "entry");
    await r.store.setDevice(r.device);
    const down = cycleRig({ upload: "down", sync: "down" });
    const res = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: down.doFetch }),
      nowLocal: () => NOW,
    });
    expect(res).toMatchObject({ kind: "offline", outbox: 1 });

    const up = cycleRig({ upload: "ok", sync: "ok" });
    const ack = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/api/scans" && url.host !== "hub.test") {
        const body = JSON.parse(String(init?.body)) as { scans: { scan_id: string }[] };
        up.calls.push(url.pathname);
        return Response.json({ acknowledged: body.scans.map((s) => s.scan_id), conflicts: [] });
      }
      return up.doFetch(input, init);
    }) as typeof fetch;
    const ok = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: ack }),
      nowLocal: () => NOW,
    });
    expect(ok).toMatchObject({ kind: "ok", link: "cloud", outbox: 0 });
    expect(up.calls.slice(0, 2)).toEqual(["/api/scans", "/api/sync"]);
  });

  it("a revoked device deletes its keys, ticket list and outbox", async () => {
    const r = rig();
    const t = await r.known(await fx.make());
    await processScan(r.deps, t.token, "entry");
    await r.store.setDevice(r.device);
    const c = cycleRig({ upload: "revoked", sync: "revoked" });
    const res = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: c.doFetch }),
      nowLocal: () => NOW,
    });
    expect(res).toEqual({ kind: "revoked" });
    expect(await r.store.getDevice()).toBeUndefined();
    expect(await r.store.ticketCount()).toBe(0);
    expect(await r.store.outboxCount()).toBe(0);
  });

  it("a revocation seen only at sync (nothing queued) wipes too", async () => {
    const r = rig();
    await r.store.setDevice(r.device);
    await r.store.putTickets([(await fx.make()).ticket]);
    const c = cycleRig({ upload: "ok", sync: "revoked" });
    const res = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: c.doFetch }),
      nowLocal: () => NOW,
    });
    expect(res.kind).toBe("revoked");
    expect(await r.store.ticketCount()).toBe(0);
  });

  it("after the event: keys and ticket list are wiped; unsent scans keep the token until uploaded", async () => {
    const r = rig();
    const t = await r.known(await fx.make());
    await processScan(r.deps, t.token, "entry");
    await r.store.setDevice(r.device);
    const late = DAY_ZERO + 86400 + 3 * 3600;

    // Still offline: tickets and keys go, the outbox (and the token to send it) stays.
    const down = cycleRig({ upload: "down", sync: "down" });
    const res = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: down.doFetch }),
      nowLocal: () => late,
    });
    expect(res).toMatchObject({ kind: "ended", outbox: 1 });
    const kept = (await r.store.getDevice())!;
    expect(kept).toMatchObject({ ended: true, synced: false, staff: [] });
    expect(kept.bundle.event_key).toBe("");
    expect(kept.token).toBe(r.device.token);
    expect(await r.store.ticketCount()).toBe(0);
    expect(await r.store.outboxCount()).toBe(1);

    // Back online: it uploads, then nothing is left on the phone.
    const ack = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.host === "hub.test") throw new TypeError("down");
      const body = JSON.parse(String(init?.body)) as { scans: { scan_id: string }[] };
      return Response.json({ acknowledged: body.scans.map((s) => s.scan_id), conflicts: [] });
    }) as typeof fetch;
    const done = await syncCycle(r.store, kept, {
      clients: clientsFor(kept, { fetch: ack }),
      nowLocal: () => late,
    });
    expect(done).toEqual({ kind: "ended", device: undefined, outbox: 0 });
    expect(await r.store.getDevice()).toBeUndefined();
  });

  it("an ended event with an empty outbox wipes everything at once; before the end nothing is wiped", async () => {
    const r = rig();
    await r.store.setDevice(r.device);
    const end = DAY_ZERO + 86400;
    const during = cycleRig({ upload: "ok", sync: "ok", hubTime: end + 3600 });
    expect(
      (
        await syncCycle(r.store, r.device, {
          clients: clientsFor(r.device, { fetch: during.doFetch }),
          nowLocal: () => end + 3600,
        })
      ).kind,
    ).toBe("ok"); // within the 2 h grace
    const after = cycleRig({ upload: "ok", sync: "ok", hubTime: end + 3 * 3600 });
    const res = await syncCycle(r.store, r.device, {
      clients: clientsFor(r.device, { fetch: after.doFetch }),
      nowLocal: () => end + 3 * 3600,
    });
    expect(res).toEqual({ kind: "ended", device: undefined, outbox: 0 });
    expect(await r.store.getDevice()).toBeUndefined();
  });
});

it("ApiRejected keeps its status (sanity for the shared error types)", () => {
  expect(new ApiRejected(403, "x", "y").status).toBe(403);
});
