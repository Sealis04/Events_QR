/**
 * Child process for the multi-process claim stress test (run with bun, which uses bun:sqlite).
 *   bun claim-worker.ts <hub.sqlite> <job.json>
 * Opens its own connection to the hub file and claims every ticket in the job for each of its
 * devices, in the order given. Prints how many claims were admitted.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../../src/server/config";
import { claimTicket } from "../../src/hub/claim";
import { openHubDb } from "../../src/hub/db";
import type { HubContext } from "../../src/hub/context";

const [dbPath, jobPath] = process.argv.slice(2) as [string, string];
const job = JSON.parse(readFileSync(jobPath, "utf8")) as {
  devices: string[];
  tickets: string[];
  eventId: number;
  now: number;
};
const opened = await openHubDb(dbPath);
const ctx: HubContext = {
  config: loadConfig({ NODE_ENV: "test", HUB_DB_PATH: dbPath }),
  db: opened.db,
  sqlite: opened.sqlite,
  now: () => job.now,
};
let admitted = 0;
let rejected = 0;
await Promise.all(
  job.devices.map(async (id) => {
    const device = {
      id,
      eventId: job.eventId,
      gate: "Gate A",
      direction: "both",
      label: null,
      kind: "scanner" as const,
    };
    for (const ticket of job.tickets) {
      const res = await claimTicket(ctx, device, {
        scan_id: randomUUID(),
        ticket_id: ticket,
        device_id: id,
        gate: "Gate A",
        scanned_at: job.now,
      });
      if (res.result === "admitted") admitted += 1;
      else rejected += 1;
    }
  }),
);
opened.close();
console.log(JSON.stringify({ admitted, rejected }));
