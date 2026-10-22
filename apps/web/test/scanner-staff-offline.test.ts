/** Staff PIN login with no network: argon2id hashes pulled during sync, lockout after wrong PINs. */
import { beforeAll, describe, expect, it } from "vitest";
import { hashPin } from "../src/server/auth";
import { NetworkError } from "../src/scanner/client";
import { MemoryStore } from "../src/scanner/memoryStore";
import {
  loginStaffAny,
  loginStaffOffline,
  MAX_PIN_FAILURES,
  OfflineLoginError,
} from "../src/scanner/staff";
import type { DeviceRecord } from "../src/scanner/types";
import { createFixtures, type Fixtures } from "./scanner-fixtures";

let fx: Fixtures;
let device: DeviceRecord;
const NOW = 1_900_000_000;

beforeAll(async () => {
  fx = await createFixtures();
  device = fx.device({
    staff: [
      { id: "s-1", name: "Sam", role: "staff", pinHash: await hashPin("246810") },
      { id: "s-2", name: "Pat Supervisor", role: "supervisor", pinHash: await hashPin("135791") },
    ],
  });
});

const fail = async (p: Promise<unknown>) => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OfflineLoginError);
  return err as OfflineLoginError;
};

describe("offline staff login", () => {
  it("accepts the right PIN with the role from the last sync (supervisor too), name case-insensitive", async () => {
    const store = new MemoryStore();
    expect(await loginStaffOffline(store, device, "Sam", "246810", () => NOW)).toEqual({
      id: "s-1",
      name: "Sam",
      role: "staff",
    });
    expect(
      await loginStaffOffline(store, device, " pat supervisor ", "135791", () => NOW),
    ).toMatchObject({
      role: "supervisor",
    });
  });

  it("refuses a wrong PIN, an unknown name and a PIN of another person", async () => {
    const store = new MemoryStore();
    expect((await fail(loginStaffOffline(store, device, "Sam", "000000", () => NOW))).reason).toBe(
      "wrong",
    );
    expect(
      (await fail(loginStaffOffline(store, device, "Nobody", "246810", () => NOW))).reason,
    ).toBe("wrong");
    expect((await fail(loginStaffOffline(store, device, "Sam", "135791", () => NOW))).reason).toBe(
      "wrong",
    );
  });

  it("never stores a PIN: the device record and the store only hold hashes and counters", async () => {
    const store = new MemoryStore();
    await fail(loginStaffOffline(store, device, "Sam", "999999", () => NOW));
    await loginStaffOffline(store, device, "Sam", "246810", () => NOW);
    expect(JSON.stringify([...store.meta.values()])).not.toMatch(/999999|246810/);
    expect(JSON.stringify(device)).not.toMatch(/246810|135791/);
  });

  it(`locks after ${MAX_PIN_FAILURES} wrong PINs, even for the right one, and the wait doubles`, async () => {
    const store = new MemoryStore();
    let now = NOW;
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++)
      expect(
        (await fail(loginStaffOffline(store, device, "Sam", "000000", () => now))).reason,
      ).toBe("wrong");
    const locked = await fail(loginStaffOffline(store, device, "Sam", "000000", () => now));
    expect(locked).toMatchObject({ reason: "locked", retryAfter: 60 });
    // The right PIN does not get in while locked (and the check is not even tried).
    const during = await fail(loginStaffOffline(store, device, "Sam", "246810", () => now + 30));
    expect(during).toMatchObject({ reason: "locked", retryAfter: 30 });
    // After the wait, five more wrong ones lock for twice as long.
    now += 61;
    for (let i = 0; i < MAX_PIN_FAILURES - 1; i++)
      await fail(loginStaffOffline(store, device, "Sam", "000000", () => now));
    expect(await fail(loginStaffOffline(store, device, "Sam", "000000", () => now))).toMatchObject({
      reason: "locked",
      retryAfter: 120,
    });
    // After the second wait the right PIN works and resets the counters.
    now += 121;
    await loginStaffOffline(store, device, "Sam", "246810", () => now);
    expect(await store.getMeta("pin-lockout")).toEqual({ fails: 0, until: 0, rounds: 0 });
  });

  it("the lockout survives a reload (it lives in the store, not in memory)", async () => {
    const store = new MemoryStore();
    for (let i = 0; i < MAX_PIN_FAILURES; i++)
      await fail(loginStaffOffline(store, device, "Sam", "000000", () => NOW));
    // A "reloaded" page: same store, a fresh call.
    expect(
      (await fail(loginStaffOffline(store, device, "Sam", "246810", () => NOW + 1))).reason,
    ).toBe("locked");
  });

  it("says so when the phone has no staff list yet", async () => {
    const empty = fx.device({ staff: [] });
    expect(
      (await fail(loginStaffOffline(new MemoryStore(), empty, "Sam", "246810", () => NOW))).reason,
    ).toBe("no_staff");
  });
});

describe("loginStaffAny: the servers first, the phone's list only when none is reachable", () => {
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;

  it("falls back to the offline check when neither server answers", async () => {
    expect(await loginStaffAny(new MemoryStore(), device, "Sam", "246810", down)).toMatchObject({
      id: "s-1",
    });
    await expect(
      loginStaffAny(new MemoryStore(), device, "Sam", "bad", down),
    ).rejects.toBeInstanceOf(OfflineLoginError);
  });

  it("a server that says no is final: no fallback to the phone's list", async () => {
    const refuse = (async () =>
      Response.json(
        { error: { code: "invalid_credentials", message: "wrong" } },
        { status: 401 },
      )) as typeof fetch;
    // Sam's PIN is right in the phone's list, but the servers (which know better) said no.
    await expect(
      loginStaffAny(new MemoryStore(), device, "Sam", "246810", refuse),
    ).rejects.toMatchObject({
      status: 401,
    });
    const limited = (async () =>
      Response.json(
        { error: { code: "too_many_attempts", message: "slow down" } },
        { status: 429 },
      )) as typeof fetch;
    await expect(
      loginStaffAny(new MemoryStore(), device, "Sam", "246810", limited),
    ).rejects.toMatchObject({
      status: 429,
    });
  });

  it("uses the server's answer when one is reachable", async () => {
    const ok = (async () =>
      Response.json({ id: "s-9", name: "Remote", role: "admin" })) as typeof fetch;
    expect(await loginStaffAny(new MemoryStore(), device, "x", "y", ok)).toEqual({
      id: "s-9",
      name: "Remote",
      role: "admin",
    });
  });

  it("NetworkError is what an unreachable server looks like", async () => {
    const { loginStaff } = await import("../src/scanner/staff");
    await expect(loginStaff("http://x", "a", "b", down)).rejects.toBeInstanceOf(NetworkError);
  });
});
