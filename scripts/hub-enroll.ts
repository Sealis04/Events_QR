/**
 * Binds this venue hub to one event, then does a first full sync so it is ready to serve gates.
 *   bun scripts/hub-enroll.ts [<server URL>] <setup code>
 * The server URL defaults to HUB_SERVER_URL. The hub's own /setup page does the same from a browser;
 * this is the fallback. A supervisor makes the code on the VM (POST /api/hubs/setup; valid 10 minutes). The hub stores
 * its credential, the event key and the public signing keys in its SQLite file (HUB_DB_PATH).
 * The Ed25519 signing secret never reaches the hub.
 */
import { loadConfig } from "../apps/web/src/server/config";
import { buildHubContext } from "../apps/web/src/hub/context";
import { linkHubToVm } from "../apps/web/src/hub/link";
import { pullCycle, pushCycle, vmClientFor } from "../apps/web/src/hub/vmsync";

const args = process.argv.slice(2);
const code = args.pop();
const config = loadConfig();
const vmUrl = args[0] ?? config.HUB_SERVER_URL;
const usage =
  "usage: bun scripts/hub-enroll.ts [<server URL>] <setup code> (URL defaults to HUB_SERVER_URL)";
if (!code || !vmUrl) throw new Error(usage);

const ctx = await buildHubContext(config, { migrate: true });
const { eventId } = await linkHubToVm(ctx, { vmUrl, code });
const vm = vmClientFor(ctx)!;
const pulled = await pullCycle(ctx, vm);
await pushCycle(ctx, vm);
ctx.sqlite.close();
console.log(
  `hub linked to ${vmUrl} for event ${eventId}: ${pulled.tickets} tickets, ${pulled.scans} scans`,
);
