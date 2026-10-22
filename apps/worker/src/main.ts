/** `APP_MODE=worker`: drains the email queue and retires signing key secrets of finished events and runs the nightly retention job. Run with `bun src/main.ts` (see docker/compose.vm.yml). */
import { loadConfig } from "@events-qr/web/server/config";
import { buildContext } from "@events-qr/web/server/context";
import { drainEmailQueue } from "./emailQueue";
import { GmailSender } from "./gmail";
import { cleanupSigningKeys, KEY_CLEANUP_INTERVAL_MS } from "./keyCleanup";
import { RETENTION_CHECK_INTERVAL_MS, retentionDue, runRetention } from "./retention";

const config = loadConfig();
if (config.APP_MODE === "hub") {
  const { hubMain } = await import("./hubMain");
  await hubMain(config);
  process.exit(0);
}

const ctx = await buildContext(config);
const { GMAIL_SA_KEY_PATH, GMAIL_SENDER } = ctx.config;
if (!GMAIL_SA_KEY_PATH || !GMAIL_SENDER) {
  console.error("worker: GMAIL_SA_KEY_PATH and GMAIL_SENDER must be set");
  process.exit(1);
}
const sender = new GmailSender({ keyPath: GMAIL_SA_KEY_PATH, sender: GMAIL_SENDER });

async function keyCleanup(): Promise<void> {
  try {
    const retired = await cleanupSigningKeys(ctx);
    if (retired.length) console.log(`worker: retired signing key secrets ${retired.join(", ")}`);
  } catch (err) {
    console.error("worker: signing key cleanup failed", err);
  }
}
await keyCleanup();
setInterval(() => void keyCleanup(), KEY_CLEANUP_INTERVAL_MS).unref();

// Nightly retention: checked hourly, runs once per UTC day after RETENTION_HOUR_UTC.
let lastRetentionDay: string | undefined;
async function retention(): Promise<void> {
  const day = retentionDue(ctx.now(), ctx.config.RETENTION_HOUR_UTC, lastRetentionDay);
  if (!day) return;
  lastRetentionDay = day;
  try {
    await runRetention(ctx);
  } catch (err) {
    console.error("worker: retention failed", err);
    lastRetentionDay = undefined; // try again at the next check
  }
}
await retention();
setInterval(() => void retention(), RETENTION_CHECK_INTERVAL_MS).unref();

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopping = true));

console.log(
  `worker: sending as ${GMAIL_SENDER}, up to ${ctx.config.EMAIL_DAILY_LIMIT} emails per 24 h`,
);
while (!stopping) {
  try {
    const r = await drainEmailQueue({ ctx, sender, from: GMAIL_SENDER });
    if (r.sent || r.failed || r.retried || r.throttled) console.log("worker: email pass", r);
  } catch (err) {
    console.error("worker: email pass failed", err);
  }
  await new Promise((resolve) => setTimeout(resolve, ctx.config.WORKER_POLL_SECONDS * 1000));
}
process.exit(0);
