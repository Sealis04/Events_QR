/** "Pull tickets now": the dashboard leaves a request, the sync worker answers it. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hexToBytes, sqliteSchema } from "@events-qr/core";
import { startHubLoops } from "../src/hub/loops";
import { createHubSession } from "../src/hub/session";
import { PULL_NOW_MIN_INTERVAL_SECONDS, requestPull, servePullRequest } from "../src/hub/pullnow";
import * as hubRoutes from "../src/hub/routes";
import { getState } from "../src/hub/state";
import { SESSION_COOKIE } from "../src/server/auth";
import { call, createTestEnv, dbAvailable, type TestEnv } from "./helpers";
import { createHubWorld, type HubWorld } from "./hub-helpers";

describe.skipIf(!dbAvailable)("pull tickets now", () => {
  let env: TestEnv;
  let w: HubWorld;
  beforeAll(async () => {
    env = await createTestEnv();
    w = await createHubWorld(env);
    await w.pull(); // staff mirrored, so dashboard sessions exist
  });
  afterAll(async () => {
    await w.close();
    await env.close();
  });

  const hasTicket = (id: string) =>
    !!w.hub.db
      .select()
      .from(sqliteSchema.tickets)
      .where(eq(sqliteSchema.tickets.id, hexToBytes(id)))
      .get();
  const cookie = (staffId: string) => ({
    cookie: `${SESSION_COOKIE}=${createHubSession(w.hub, staffId)}`,
  });
  /** The worker's side, a moment after the request was left. */
  const worker = () => new Promise((r) => setTimeout(r, 30)).then(() => servePullRequest(w.hub));
  const pastLimit = () => (env.clock.now += PULL_NOW_MIN_INTERVAL_SECONDS + 1);

  it("pulls a ticket made on the VM and reports what changed", async () => {
    pastLimit();
    const t = await w.makeTicket(0, "Pull me");
    env.clock.now += 2; // past the VM's sync horizon
    expect(hasTicket(t.id)).toBe(false);
    const [result] = await Promise.all([requestPull(w.hub, { pollMs: 10 }), worker()]);
    expect(result).toMatchObject({ ok: true, tickets: 1 });
    expect(result.changes).toBeGreaterThanOrEqual(1);
    expect(result.last_pull_at).toBe(env.clock.now);
    expect(hasTicket(t.id)).toBe(true);
  });

  it("is limited to one request per 10 s, with the wait in the answer", async () => {
    pastLimit();
    await Promise.all([requestPull(w.hub, { pollMs: 10 }), worker()]);
    env.clock.now += PULL_NOW_MIN_INTERVAL_SECONDS - 3;
    const again = await call(hubRoutes.pullNow, { staff: cookie(w.supervisor.id), body: {} });
    expect(again.status).toBe(429);
    expect(again.json.error).toMatchObject({ code: "rate_limited", details: { retry_after: 3 } });
    // Nothing was queued by the refused request.
    expect(getState(w.hub, "pull_request")).toBe(getState(w.hub, "pull_handled"));
    env.clock.now += 3;
    const [ok] = await Promise.all([
      call(hubRoutes.pullNow, { staff: cookie(w.supervisor.id), body: {} }),
      worker(),
    ]);
    expect(ok.status).toBe(200);
    expect(ok.json.ok).toBe(true);
  });

  it("with the VM unreachable it says so and names the last successful pull", async () => {
    pastLimit();
    const [good] = await Promise.all([requestPull(w.hub, { pollMs: 10 }), worker()]);
    expect(good.ok).toBe(true);
    pastLimit();
    w.cutUplink();
    const [down] = await Promise.all([requestPull(w.hub, { pollMs: 10 }), worker()]);
    w.restoreUplink();
    expect(down).toMatchObject({ ok: false, error: "vm_unreachable", changes: 0 });
    expect(down.last_pull_at).toBe(good.last_pull_at);
  });

  it("answers 'no answer' when no worker picks the request up", async () => {
    pastLimit();
    const r = await requestPull(w.hub, { waitMs: 60, pollMs: 10 });
    expect(r).toMatchObject({ ok: false, error: "no_answer" });
    // The worker that starts later still answers it, once.
    expect(await servePullRequest(w.hub)).toBe(true);
    expect(await servePullRequest(w.hub)).toBe(false);
  });

  it("needs a supervisor session; phones' device tokens and staff are refused", async () => {
    pastLimit();
    expect((await call(hubRoutes.pullNow, { body: {} })).status).toBe(401);
    expect((await call(hubRoutes.pullNow, { staff: cookie(w.staff.id), body: {} })).status).toBe(
      403,
    );
  });

  it("the worker's loops answer a request on their own", async () => {
    pastLimit();
    const t = await w.makeTicket(0, "Loop pull");
    env.clock.now += 2;
    const loops = startHubLoops(w.hub, {
      // Only the one-second watcher matters here: the scheduled loops sleep for the whole test.
      sleep: (ms, signal) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, ms === 1000 ? 10 : 60_000);
          signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
        }),
    });
    try {
      const result = await requestPull(w.hub, { pollMs: 10 });
      expect(result.ok).toBe(true);
      expect(hasTicket(t.id)).toBe(true);
    } finally {
      await loops.stop();
    }
  });
});
