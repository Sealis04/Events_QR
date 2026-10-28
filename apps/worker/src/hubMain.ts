/**
 * `APP_MODE=hub` worker: the venue hub's sync loops (ticket pull, scan push). The hub's web app
 * (`APP_MODE=hub`, same SQLite file) serves the phones; this process keeps it in step with the VM.
 * Run with `bun src/main.ts` (see docker/compose.hub.yml). Applies the SQLite migrations first.
 */
import type { Config } from "@events-qr/web/server/config";
import { buildHubContext } from "@events-qr/web/hub/context";
import { startHubLoops } from "@events-qr/web/hub/loops";
import { getLink } from "@events-qr/web/hub/state";

export async function hubMain(config: Config): Promise<void> {
  const ctx = await buildHubContext(config, { migrate: true });
  if (!getLink(ctx)) {
    console.log(
      "hub: not linked to a server yet; enter a setup code on the hub's /setup page (or run scripts/hub-enroll.ts <code>). Waiting for it.",
    );
  }
  const loops = startHubLoops(ctx, {
    log: (message, detail) => console.log(message, detail ?? ""),
  });
  console.log(
    `hub: syncing with the VM (pull every ${config.HUB_TICKET_PULL_SECONDS} s, push every ${config.HUB_SCAN_PUSH_SECONDS} s)`,
  );
  await new Promise<void>((resolve) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => resolve());
  });
  await loops.stop();
  ctx.sqlite.close();
}
