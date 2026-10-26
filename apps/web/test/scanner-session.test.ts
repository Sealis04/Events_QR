/** The lasting phone login: expiry rule (05:00 event-local, DST-free, crossing midnight) and persistence. */
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { IdbStore } from "../src/scanner/idbStore";
import { MemoryStore } from "../src/scanner/memoryStore";
import {
  clearSession,
  loadSession,
  saveSession,
  serverNow,
  sessionExpiry,
} from "../src/scanner/session";
import { createFixtures, DAY_ZERO, STAFF, type Fixtures } from "./scanner-fixtures";

const H = 3600;
const DAY = 24 * H;
const OPEN_END = Number.MAX_SAFE_INTEGER;

describe("sessionExpiry", () => {
  it("a login in the afternoon lasts until 05:00 the next morning", () => {
    expect(sessionExpiry(DAY_ZERO + 14 * H, DAY_ZERO, OPEN_END)).toBe(DAY_ZERO + DAY + 5 * H);
  });

  it("a login after midnight but before 05:00 ends at 05:00 the same night (late shift not cut at midnight)", () => {
    const loginAt = DAY_ZERO + DAY + 1 * H; // 01:00 on day 1
    expect(sessionExpiry(loginAt, DAY_ZERO, OPEN_END)).toBe(DAY_ZERO + DAY + 5 * H);
  });

  it("is still valid across midnight", () => {
    const loginAt = DAY_ZERO + 22 * H;
    const expires = sessionExpiry(loginAt, DAY_ZERO, OPEN_END);
    expect(DAY_ZERO + DAY + 30 * 60).toBeLessThan(expires); // 00:30 next day
  });

  it("exactly 05:00 starts a new day: the login lasts until 05:00 the day after", () => {
    expect(sessionExpiry(DAY_ZERO + 5 * H, DAY_ZERO, OPEN_END)).toBe(DAY_ZERO + DAY + 5 * H);
  });

  it("a login before the event's first 05:00 (day_zero is local midnight) ends that morning", () => {
    expect(sessionExpiry(DAY_ZERO + 2 * H, DAY_ZERO, OPEN_END)).toBe(DAY_ZERO + 5 * H);
  });

  it("works for a login before day zero (early test login)", () => {
    expect(sessionExpiry(DAY_ZERO - 3 * H, DAY_ZERO, OPEN_END)).toBe(DAY_ZERO + 5 * H);
  });

  it("is capped at the end of the event", () => {
    expect(sessionExpiry(DAY_ZERO + 14 * H, DAY_ZERO, DAY_ZERO + 20 * H)).toBe(DAY_ZERO + 20 * H);
  });
});

describe("saved login", () => {
  let fx: Fixtures;
  beforeEach(async () => {
    fx = await createFixtures();
  });
  const device = () =>
    fx.device({
      clockOffset: 0,
      bundle: { ...fx.device().bundle, day_zero: DAY_ZERO, ends_at: DAY_ZERO + 5 * DAY },
    });

  it("comes back until the cut-off, then is gone and asks again", async () => {
    const store = new MemoryStore();
    const d = device();
    const t0 = DAY_ZERO + 18 * H;
    await saveSession(store, d, STAFF, t0);
    expect(await loadSession(store, d, t0 + 6 * H)).toEqual(STAFF); // 00:00, midnight crossed
    expect(await loadSession(store, d, DAY_ZERO + DAY + 5 * H - 1)).toEqual(STAFF);
    expect(await loadSession(store, d, DAY_ZERO + DAY + 5 * H)).toBeNull();
    expect(await loadSession(store, d, t0)).toBeNull(); // the expired record was deleted
  });

  it("sign out ends it", async () => {
    const store = new MemoryStore();
    const d = device();
    await saveSession(store, d, STAFF, DAY_ZERO + 10 * H);
    await clearSession(store);
    expect(await loadSession(store, d, DAY_ZERO + 11 * H)).toBeNull();
  });

  it("another device's login is not accepted", async () => {
    const store = new MemoryStore();
    await saveSession(store, device(), STAFF, DAY_ZERO + 10 * H);
    const other = { ...device(), deviceId: "99999999-9999-4999-8999-999999999999" };
    expect(await loadSession(store, other, DAY_ZERO + 11 * H)).toBeNull();
  });

  it("an ended event ends it; wipe() deletes it (revoke, set up again)", async () => {
    const store = new MemoryStore();
    const d = device();
    await saveSession(store, d, STAFF, DAY_ZERO + 10 * H);
    expect(await loadSession(store, { ...d, ended: true }, DAY_ZERO + 11 * H)).toBeNull();
    await saveSession(store, d, STAFF, DAY_ZERO + 10 * H);
    await store.wipe();
    expect(await loadSession(store, d, DAY_ZERO + 11 * H)).toBeNull();
  });

  it("uses the server clock (clockOffset) for the cut-off", async () => {
    const d = { ...device(), clockOffset: 100 };
    expect(serverNow(d, 5_000_000)).toBe(5000 + 100);
  });

  it("survives closing and reopening the browser: same IndexedDB, new store object, still sealed", async () => {
    const d = device();
    const first = new IdbStore();
    await first.wipe();
    await saveSession(first, d, STAFF, DAY_ZERO + 10 * H);
    await first.close();
    const reopened = new IdbStore();
    expect(await loadSession(reopened, d, DAY_ZERO + 12 * H)).toEqual(STAFF);
    await reopened.wipe();
    expect(await loadSession(reopened, d, DAY_ZERO + 12 * H)).toBeNull();
    await reopened.close();
  });
});
