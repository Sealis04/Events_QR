import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, hexToBytes, sqliteSchema } from "@events-qr/core";
import { POST as generate } from "../src/app/api/events/[id]/tickets/route";
import { call, createTestEnv, dbAvailable, newKey, type TestEnv } from "./helpers";
import { createHubWorld, type HubDevice, type HubWorld } from "./hub-helpers";

const { tickets, scans, hubScanOutbox } = sqliteSchema;

describe.skipIf(!dbAvailable)("hub claim on SQLite", () => {
  let env: TestEnv;
  let world: HubWorld;

  beforeAll(async () => {
    env = await createTestEnv();
    world = await createHubWorld(env);
  });
  afterAll(async () => {
    await world.close();
    await env.close();
  });

  /** One request makes `n` tickets of a type on the VM. */
  async function bulkTickets(n: number, type = 0): Promise<string[]> {
    const res = await call(generate, {
      staff: world.staff,
      params: { id: String(world.eventId) },
      body: { idempotency_key: newKey(), ticket_type: type, quantity: n, holder_name: "Bulk" },
    });
    expect(res.status).toBe(201);
    return res.json.tickets.map((t: { ticket_id: string }) => t.ticket_id);
  }

  it("20 simulated devices claiming the same 100 tickets at once give exactly 100 admits", async () => {
    const ids = await bulkTickets(100);
    await world.pull();
    const devices: HubDevice[] = [];
    for (let i = 0; i < 20; i++) devices.push(await world.enrolAtHub("Gate A", "entry"));

    // Every device tries every ticket, each device in its own shuffled order, all interleaved.
    const attempts = devices.flatMap((d, di) =>
      [...ids]
        .sort((a, b) => (hexToBytes(a)[di % 16]! ^ hexToBytes(b)[(di + 3) % 16]!) - 128)
        .map((t) => () => world.hubClaim(d, world.scanBody(d, t))),
    );
    const results = await Promise.all(attempts.map((run) => run()));

    expect(results.every((r) => r.status === 200)).toBe(true);
    const verdicts = results.map((r) => r.json.result as string);
    expect(verdicts.filter((v) => v === "admitted")).toHaveLength(100);
    expect(verdicts.filter((v) => v === "rejected_inside")).toHaveLength(1900);
    for (const r of results) expect(() => api.claimResponse.parse(r.json)).not.toThrow();

    const rows = world.hub.db.select().from(tickets).all();
    const mine = rows.filter((r) => ids.includes(Buffer.from(r.id).toString("hex")));
    expect(mine).toHaveLength(100);
    expect(mine.every((r) => r.admitsUsed === 1 && r.inside && r.status === "used_up")).toBe(true);
    // Every attempt is logged exactly once and queued for the VM.
    const attemptsLogged = world.hub.db.select().from(scans).all().length;
    const outbox = world.hub.db.select().from(hubScanOutbox).all().length;
    expect(attemptsLogged).toBe(2000);
    expect(outbox).toBe(2000);
  });

  const bunPath = spawnSync("bun", ["--version"]).status === 0;
  it.skipIf(!bunPath)(
    "separate processes on the same SQLite file (as the web app and worker are) also admit each ticket once",
    async () => {
      const ids = await bulkTickets(60);
      await world.pull();
      const devices: HubDevice[] = [];
      for (let i = 0; i < 8; i++) devices.push(await world.enrolAtHub("Gate A", "both"));

      const worker = join(dirname(new URL(import.meta.url).pathname), "fixtures/claim-worker.ts");
      const runOne = (chunk: HubDevice[], idx: number) =>
        new Promise<{ admitted: number; rejected: number }>((resolve, reject) => {
          const job = join(dirname(world.dbPath), `job-${idx}.json`);
          writeFileSync(
            job,
            JSON.stringify({
              devices: chunk.map((d) => d.id),
              tickets: idx % 2 ? [...ids].reverse() : ids,
              eventId: world.eventId,
              now: env.clock.now,
            }),
          );
          const child = spawn("bun", [worker, world.dbPath, job], {
            stdio: ["ignore", "pipe", "inherit"],
          });
          let out = "";
          child.stdout.on("data", (d) => (out += d));
          child.on("close", (code) =>
            code === 0
              ? resolve(JSON.parse(out.trim().split("\n").pop()!))
              : reject(new Error(`worker exited ${code}: ${out}`)),
          );
        });
      const outcomes = await Promise.all(
        [0, 1, 2, 3].map((i) => runOne(devices.slice(i * 2, i * 2 + 2), i)),
      );
      expect(outcomes.reduce((n, o) => n + o.admitted, 0)).toBe(60);
      expect(outcomes.reduce((n, o) => n + o.rejected, 0)).toBe(60 * 8 - 60);
      for (const id of ids) {
        const row = world.hub.db
          .select()
          .from(tickets)
          .where(eq(tickets.id, hexToBytes(id)))
          .get()!;
        expect(row.admitsUsed).toBe(1);
      }
    },
    120_000,
  );

  it("claims a ticket issued after the last pull by asking the VM on demand; with the VM unreachable it is refused", async () => {
    const dev = await world.enrolAtHub("Gate A", "entry");
    const fresh = await world.makeTicket(0, "Late issue");
    env.clock.now += 2;
    const ok = await world.hubClaim(dev, world.scanBody(dev, fresh.id));
    expect(ok.json).toMatchObject({ result: "admitted", limit: 1 });

    const later = await world.makeTicket(0, "Later still");
    env.clock.now += 2;
    world.cutUplink();
    try {
      const refused = await world.hubClaim(dev, world.scanBody(dev, later.id));
      expect(refused.status).toBe(404);
    } finally {
      world.restoreUplink();
    }
  });

  it("an unknown or revoked device, or no token, is refused", async () => {
    const t = (await world.makeTicket(0)).id;
    await world.pull();
    const dev = await world.enrolAtHub("Gate A", "entry");
    expect(
      (await world.hubClaim({ id: dev.id, token: "nope" }, world.scanBody(dev, t))).status,
    ).toBe(401);
    world.hub.db
      .update(sqliteSchema.devices)
      .set({ revoked: true })
      .where(eq(sqliteSchema.devices.id, dev.id))
      .run();
    expect((await world.hubClaim(dev, world.scanBody(dev, t))).status).toBe(401);
  });

  it("randomUUID scan ids are the only thing a replay needs: same id, same answer", async () => {
    const t = (await world.makeTicket(1)).id;
    await world.pull();
    const dev = await world.enrolAtHub("Gate A", "both");
    const body = { ...world.scanBody(dev, t), scan_id: randomUUID() };
    const a = await world.hubClaim(dev, body);
    const b = await world.hubClaim(dev, body);
    expect(b.json).toEqual(a.json);
  });
});
