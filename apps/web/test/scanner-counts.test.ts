/** "This phone today: N in · M out": counted on the phone, per event-local day, kept in the store. */
import { describe, expect, it } from "vitest";
import { bumpCount, readCounts } from "../src/scanner/counts";
import { MemoryStore } from "../src/scanner/memoryStore";
import { createFixtures, DAY_ZERO } from "./scanner-fixtures";

describe("today counts", () => {
  it("counts in and out separately, survive a re-read, and start over on the next event day", async () => {
    const fx = await createFixtures();
    const device = fx.device();
    const store = new MemoryStore();
    const noon = DAY_ZERO + 12 * 3600;
    await bumpCount(store, device, "in", noon);
    await bumpCount(store, device, "in", noon + 60);
    await bumpCount(store, device, "out", noon + 120);
    expect(await readCounts(store, device, noon + 200)).toMatchObject({ in: 2, out: 1 });
    expect(await readCounts(store, device, noon + 86400)).toMatchObject({ in: 0, out: 0 });
  });

  it("is deleted with the rest of the phone's data", async () => {
    const fx = await createFixtures();
    const device = fx.device();
    const store = new MemoryStore();
    await bumpCount(store, device, "in", DAY_ZERO + 100);
    await store.wipe();
    expect(await readCounts(store, device, DAY_ZERO + 100)).toMatchObject({ in: 0, out: 0 });
  });
});
