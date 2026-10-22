/**
 * Binds this venue hub to one event, then does a first full sync so it is ready to serve gates.
 *   bun scripts/hub-enroll.ts <VM URL> <setup code>
 * A supervisor makes the code on the VM (POST /api/hubs/setup; valid 10 minutes). The hub stores
 * its credential, the event key and the public signing keys in its SQLite file (HUB_DB_PATH).
 * The Ed25519 signing secret never reaches the hub.
 */
import { loadConfig } from "../apps/web/src/server/config";
import { buildHubContext } from "../apps/web/src/hub/context";
import { linkHubToVm } from "../apps/web/src/hub/link";
import { pullCycle, pushCycle, vmClientFor } from "../apps/web/src/hub/vmsync";

const [vmUrl, code] = process.argv.slice(2);
if (!vmUrl || !code) throw new Error("usage: bun scripts/hub-enroll.ts <VM URL> <setup code>");

const ctx = await buildHubContext(loadConfig(), { migrate: true });
const { eventId } = await linkHubToVm(ctx, { vmUrl, code });
const vm = vmClientFor(ctx)!;
const pulled = await pullCycle(ctx, vm);
await pushCycle(ctx, vm);
ctx.sqlite.close();
console.log(
  `hub linked to ${vmUrl} for event ${eventId}: ${pulled.tickets} tickets, ${pulled.scans} scans`,
);
