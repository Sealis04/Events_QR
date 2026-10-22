/** `APP_MODE=worker`: drains the email queue and retires signing key secrets of finished events. Run with `bun src/main.ts` (see docker/compose.vm.yml). */
import { buildContext } from "@events-qr/web/server/context";
import { drainEmailQueue } from "./emailQueue";
import { GmailSender } from "./gmail";
import { cleanupSigningKeys, KEY_CLEANUP_INTERVAL_MS } from "./keyCleanup";

const ctx = await buildContext();
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
