import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeSetupCode } from "@events-qr/core";
import { ApiRejected, AuthError, NetworkError } from "../src/scanner/client";
import { MemoryStore } from "../src/scanner/memoryStore";
import { cloudBase, clientsFor, hubBase, RoutedClient, type Link } from "../src/scanner/routes";
import { loginStaffRouted } from "../src/scanner/staff";
import { enrollFromSetupQr, syncFromBest } from "../src/scanner/sync";
import type { DeviceRecord } from "../src/scanner/types";

const HUB = "https://hub.example.org";
const VM = "https://tickets.example.org";
const TICKET = "ab".repeat(16);

const bundle = {
  event_id: 1,
  event_key: "AAAA",
  public_keys: { "1": "AAAA" },
  gates: ["Gate A"],
  starts_at: 1,
  ends_at: 2,
  day_zero: 1,
  ticket_types: [],
};

function device(extra: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    deviceId: randomUUID(),
    token: "tok",
    serverUrl: HUB,
    hubUrl: HUB,
    cloudUrl: VM,
    gate: "Gate A",
    direction: "entry",
    label: null,
    bundle,
    clockOffset: 0,
    cursor: null,
    cloudCursor: null,
    synced: true,
    ticketTypes: [],
    ...extra,
  };
}

type Behaviour = "ok" | "down" | "slow" | "401" | "404" | "409";
interface Calls {
  hub: number;
  cloud: number;
  bodies: { scan_id?: string }[];
  urls: string[];
}

/** A fetch that plays the hub and the VM; each can be told how to behave. */
function world(state: { hub: Behaviour; cloud: Behaviour }) {
  const calls: Calls = { hub: 0, cloud: 0, bodies: [], urls: [] };
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    const which = url.startsWith(HUB) ? "hub" : "cloud";
    calls[which] += 1;
    calls.urls.push(url);
    if (init?.body) calls.bodies.push(JSON.parse(String(init.body)));
    const behaviour = state[which];
    if (behaviour === "down") throw new TypeError("fetch failed");
    if (behaviour === "slow") {
      await new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new TypeError("aborted"))),
      );
    }
    const failure = { "401": 401, "404": 404, "409": 409 }[behaviour as "401"];
    if (failure)
      return new Response(JSON.stringify({ error: { code: "x", message: "no" } }), {
        status: failure,
      });
    const path = new URL(url).pathname;
    if (path === "/api/sync")
      return Response.json({
        tickets: [],
        devices: [],
        ticket_types: [],
        next_cursor: `${which === "hub" ? 100 : 7}:${"00".repeat(16)}`,
        has_more: false,
        hub_time: 1000,
      });
    return Response.json({ result: "admitted", admits_used: 1, limit: 1, from: which });
  };
  return { fetcher, calls };
}

const claimBody = (scanId = randomUUID()) => ({
  scan_id: scanId,
  ticket_id: TICKET,
  device_id: randomUUID(),
  gate: "Gate A",
  scanned_at: 1,
});

describe("hub-first routing", () => {
  it("uses the hub when it answers and never bothers the VM", async () => {
    const w = world({ hub: "ok", cloud: "ok" });
    const seen: Link[] = [];
    const client = new RoutedClient(clientsFor(device(), { fetch: w.fetcher }), (l) =>
      seen.push(l),
    );
    expect(await client.claim(claimBody())).toMatchObject({ from: "hub" });
    expect(w.calls).toMatchObject({ hub: 1, cloud: 0 });
    expect(seen).toEqual(["hub"]);
  });

  it("falls back to the VM when the hub does not answer within its window, with the same scan_id, then goes back to the hub", async () => {
    const state = { hub: "slow" as Behaviour, cloud: "ok" as Behaviour };
    const w = world(state);
    const seen: Link[] = [];
    const client = new RoutedClient(
      clientsFor(device(), { fetch: w.fetcher, hubTimeoutMs: 40 }),
      (l) => seen.push(l),
    );
    const body = claimBody();
    const started = Date.now();
    expect(await client.claim(body)).toMatchObject({ from: "cloud" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(seen).toEqual(["cloud"]); // pill: Cloud-only
    expect(w.calls.bodies.map((b) => b.scan_id)).toEqual([body.scan_id, body.scan_id]);

    // The hub is retried on every scan: when it is back the next scan uses it.
    state.hub = "ok";
    expect(await client.claim(claimBody())).toMatchObject({ from: "hub" });
    expect(seen).toEqual(["cloud", "hub"]);
  });

  it("falls back when the hub is down or does not have the ticket; other refusals stand", async () => {
    for (const hub of ["down", "404"] as const) {
      const w = world({ hub, cloud: "ok" });
      const client = new RoutedClient(clientsFor(device(), { fetch: w.fetcher }));
      expect(await client.exit(claimBody())).toMatchObject({ from: "cloud" });
    }
    const w = world({ hub: "409", cloud: "ok" });
    const client = new RoutedClient(clientsFor(device(), { fetch: w.fetcher }));
    await expect(client.claim(claimBody())).rejects.toBeInstanceOf(ApiRejected);
    expect(w.calls.cloud).toBe(0);
  });

  it("reports Offline when neither server answers", async () => {
    const w = world({ hub: "down", cloud: "down" });
    const seen: Link[] = [];
    const client = new RoutedClient(clientsFor(device(), { fetch: w.fetcher }), (l) =>
      seen.push(l),
    );
    await expect(client.claim(claimBody())).rejects.toBeInstanceOf(NetworkError);
    expect(seen).toEqual(["offline"]);
  });

  it("a phone with no hub talks to the VM only", async () => {
    const w = world({ hub: "down", cloud: "ok" });
    const d = device({ hubUrl: null, serverUrl: VM });
    expect(hubBase(d)).toBeNull();
    const client = new RoutedClient(clientsFor(d, { fetch: w.fetcher }));
    expect(await client.claim(claimBody())).toMatchObject({ from: "cloud" });
    expect(w.calls.hub).toBe(0);
    // The hub address equal to the VM's is no hub either (setup QR made without HUB_URL).
    expect(hubBase(device({ hubUrl: VM, serverUrl: VM }))).toBeNull();
    expect(cloudBase(device({ cloudUrl: undefined, serverUrl: `${VM}/` }))).toBe(VM);
  });

  describe("a 401 only wipes the phone when the server it enrolled at says so", () => {
    it("enrolled at the VM: the hub not knowing the phone yet is not a wipe", async () => {
      const w = world({ hub: "401", cloud: "ok" });
      const client = new RoutedClient(clientsFor(device({ serverUrl: VM }), { fetch: w.fetcher }));
      expect(await client.claim(claimBody())).toMatchObject({ from: "cloud" });
    });

    it("enrolled at the VM: the VM saying 401 is a wipe", async () => {
      const w = world({ hub: "down", cloud: "401" });
      const client = new RoutedClient(clientsFor(device({ serverUrl: VM }), { fetch: w.fetcher }));
      await expect(client.claim(claimBody())).rejects.toBeInstanceOf(AuthError);
    });

    it("enrolled at the hub: the VM not knowing the phone yet is just 'offline'; the hub saying 401 is a wipe, without asking the VM", async () => {
      const notYet = world({ hub: "down", cloud: "401" });
      const c1 = new RoutedClient(
        clientsFor(device({ serverUrl: HUB }), { fetch: notYet.fetcher }),
      );
      await expect(c1.claim(claimBody())).rejects.toBeInstanceOf(NetworkError);

      const revoked = world({ hub: "401", cloud: "ok" });
      const c2 = new RoutedClient(
        clientsFor(device({ serverUrl: HUB }), { fetch: revoked.fetcher }),
      );
      await expect(c2.claim(claimBody())).rejects.toBeInstanceOf(AuthError);
      expect(revoked.calls.cloud).toBe(0);
    });
  });
});

describe("device pull with two servers", () => {
  it("keeps one cursor per server and reports which answered", async () => {
    const state = { hub: "ok" as Behaviour, cloud: "ok" as Behaviour };
    const w = world(state);
    const store = new MemoryStore();
    await store.setDevice(device());
    const clients = () => clientsFor(device(), { fetch: w.fetcher });

    expect((await syncFromBest(store, clients())).link).toBe("hub");
    state.hub = "down";
    const viaCloud = await syncFromBest(store, clients());
    expect(viaCloud.link).toBe("cloud");
    expect(viaCloud.device.cursor?.startsWith("100:")).toBe(true);
    expect(viaCloud.device.cloudCursor?.startsWith("7:")).toBe(true);

    // The hub's cursor is never sent to the VM, nor the VM's to the hub.
    state.hub = "ok";
    await syncFromBest(store, clients());
    const hubCalls = w.calls.urls.filter((u) => u.startsWith(HUB));
    expect(hubCalls.at(-1)).toContain(`cursor=100:`);
    const cloudCalls = w.calls.urls.filter((u) => u.startsWith(VM));
    expect(cloudCalls.at(-1)).not.toContain("cursor=");
  });

  it("with both servers down the pull fails, and the phone stays as it was", async () => {
    const w = world({ hub: "down", cloud: "down" });
    const store = new MemoryStore();
    await store.setDevice(device());
    await expect(
      syncFromBest(store, clientsFor(device(), { fetch: w.fetcher })),
    ).rejects.toBeInstanceOf(NetworkError);
    expect((await store.getDevice())?.synced).toBe(true);
  });
});

describe("staff login at the hub, then the VM", () => {
  const loginWorld = (hub: number | "down", cloud: number | "down") => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      const which = url.startsWith(HUB) ? hub : cloud;
      seen.push(url.startsWith(HUB) ? "hub" : "cloud");
      if (which === "down") throw new TypeError("fetch failed");
      if (which !== 200)
        return new Response(
          JSON.stringify({ error: { code: "e", message: "wrong name or PIN" } }),
          {
            status: which,
          },
        );
      return Response.json({ id: randomUUID(), name: "Sam", role: "staff" });
    };
    return { fetcher, seen };
  };

  it("logs in at the hub when it answers", async () => {
    const w = loginWorld(200, 200);
    expect(await loginStaffRouted(device(), "Sam", "123456", w.fetcher)).toMatchObject({
      name: "Sam",
    });
    expect(w.seen).toEqual(["hub"]);
  });

  it("asks the VM when the hub is down or does not know the name", async () => {
    for (const hub of ["down", 401] as const) {
      const w = loginWorld(hub, 200);
      expect(await loginStaffRouted(device(), "Sam", "123456", w.fetcher)).toMatchObject({
        name: "Sam",
      });
      expect(w.seen).toEqual(["hub", "cloud"]);
    }
  });

  it("a wrong PIN on both is a refusal; too many attempts stops at once; nothing reachable is a network error", async () => {
    await expect(
      loginStaffRouted(device(), "Sam", "bad", loginWorld(401, 401).fetcher),
    ).rejects.toMatchObject({ status: 401 });
    const limited = loginWorld(429, 200);
    await expect(loginStaffRouted(device(), "Sam", "bad", limited.fetcher)).rejects.toMatchObject({
      status: 429,
    });
    expect(limited.seen).toEqual(["hub"]);
    await expect(
      loginStaffRouted(device(), "Sam", "x", loginWorld("down", "down").fetcher),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe("enrolment tries the hub first, then the VM", () => {
  const exchange = () =>
    Response.json({
      device_id: randomUUID(),
      device_token: "token",
      key_bundle: { ...bundle, cloud_url: VM },
      gate: "Gate A",
      direction: "entry",
      label: null,
    });
  const qr = encodeSetupCode({ eventId: 1, code: "one-time", hubUrl: HUB });

  function enrolWorld(hubUp: boolean) {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const hub = url.startsWith(HUB);
      if (hub && !hubUp) throw new TypeError("fetch failed");
      if (new URL(url).pathname === "/api/devices/enroll") return exchange();
      return Response.json({
        tickets: [],
        devices: [],
        ticket_types: [],
        next_cursor: null,
        has_more: false,
        hub_time: 5,
      });
    };
    return { fetcher, calls };
  }

  it("enrols at the hub with no VM reachable, and learns the VM's address from the key bundle", async () => {
    const w = enrolWorld(true);
    const store = new MemoryStore();
    const d = await enrollFromSetupQr(store, qr, { fetch: w.fetcher, pageOrigin: VM });
    expect(d).toMatchObject({ serverUrl: HUB, hubUrl: HUB, cloudUrl: VM, synced: true });
    expect(w.calls.every((u) => u.startsWith(HUB))).toBe(true);
  });

  it("enrols at the VM (the page's origin) when the hub does not answer", async () => {
    const w = enrolWorld(false);
    const store = new MemoryStore();
    const d = await enrollFromSetupQr(store, qr, {
      fetch: w.fetcher,
      pageOrigin: VM,
      hubTimeoutMs: 50,
    });
    expect(d).toMatchObject({ serverUrl: VM, hubUrl: HUB, cloudUrl: VM, synced: true });
    // The first full sync also falls back to the VM, with the VM's own cursor.
    expect((await store.getDevice())?.cloudCursor).toBeNull();
  });

  it("treats a hub that errors (not linked yet) like one that is down", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith(HUB)) return new Response("{}", { status: 503 });
      if (new URL(url).pathname === "/api/devices/enroll") return exchange();
      return Response.json({
        tickets: [],
        devices: [],
        ticket_types: [],
        next_cursor: null,
        has_more: false,
        hub_time: 5,
      });
    };
    const d = await enrollFromSetupQr(new MemoryStore(), qr, { fetch: fetcher, pageOrigin: VM });
    expect(d.serverUrl).toBe(VM);
  });

  it("fails with a network error when nothing answers", async () => {
    const store = new MemoryStore();
    await expect(
      enrollFromSetupQr(store, qr, {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
        pageOrigin: VM,
        hubTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({ reason: "network" });
  });
});
