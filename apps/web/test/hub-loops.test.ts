import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hexToBytes, mysqlSchema, sqliteSchema } from "@events-qr/core";
import { nextDelayMs, startHubLoops } from "../src/hub/loops";
import { createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

describe("backoff", () => {
  it("keeps the normal pace while the VM answers and doubles per failure up to the cap", () => {
    expect(nextDelayMs(5000, 0, 60_000)).toBe(5000);
    expect([1, 2, 3, 4, 5].map((n) => nextDelayMs(5000, n, 60_000))).toEqual([
      10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
    expect(nextDelayMs(30_000, 1, 60_000)).toBe(60_000);
  });
});

describe.skipIf(!dbAvailable)("hub sync loops", () => {
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

  it("pull and push run on their own, back off while the VM is unreachable, and catch up when it returns", async () => {
    const dev = await w.enrolAtHub("Gate A", "entry");
    const t = await w.makeTicket(0, "Loop ticket");
    env.clock.now += 2;

    // A fake clock for the loops: every sleep parks until the test releases it.
    const sleeps: { ms: number; release(): void }[] = [];
    const logs: string[] = [];
    const settled = async (count: number) => {
      for (let i = 0; i < 200 && sleeps.length < count; i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(sleeps).toHaveLength(count);
    };
    const releaseAll = () => sleeps.splice(0).forEach((s) => s.release());
    const loops = startHubLoops(w.hub, {
      log: (m) => logs.push(m),
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          // The one-second "Pull tickets now" watcher (hub/pullnow.ts) is not part of this test.
          if (ms === 1000) {
            const timer = setTimeout(resolve, 20);
            signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), {
              once: true,
            });
            return;
          }
          const release = () => resolve();
          sleeps.push({ ms, release });
          signal.addEventListener("abort", release, { once: true });
        }),
    });

    // First pass of both loops: the ticket arrives, nothing to push. Normal pace afterwards.
    await settled(2);
    expect(
      w.hub.db
        .select()
        .from(sqliteSchema.tickets)
        .where(eq(sqliteSchema.tickets.id, hexToBytes(t.id)))
        .get(),
    ).toBeDefined();
    expect(sleeps.map((s) => s.ms).sort((a, b) => a - b)).toEqual([5000, 30_000]);

    // Uplink cut: the hub keeps admitting; both loops back off.
    w.cutUplink();
    expect((await w.hubClaim(dev, w.scanBody(dev, t.id))).json.result).toBe("admitted");
    releaseAll();
    await settled(2);
    expect(sleeps.map((s) => s.ms).sort((a, b) => a - b)).toEqual([10_000, 60_000]);
    releaseAll();
    await settled(2);
    expect(sleeps.map((s) => s.ms).sort((a, b) => a - b)).toEqual([20_000, 60_000]);
    expect(logs.filter((m) => m.includes("retrying"))).toHaveLength(2); // logged once per outage, not per retry
    expect(await env.handle.db.select().from(mysqlSchema.scans)).toHaveLength(0);

    // The VM is back: the next passes succeed, the scan uploads, the pace returns to normal.
    w.restoreUplink();
    releaseAll();
    await settled(2);
    expect(sleeps.map((s) => s.ms).sort((a, b) => a - b)).toEqual([5000, 30_000]);
    expect(logs.some((m) => m.includes("the VM is back"))).toBe(true);
    const uploaded = await env.handle.db.select().from(mysqlSchema.scans);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.result).toBe("admitted");

    releaseAll();
    await loops.stop();
  });
});
