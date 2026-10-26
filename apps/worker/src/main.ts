/** `APP_MODE=worker`: drains the email queue and retires signing key secrets of finished events and runs the nightly retention job. Run with `bun src/main.ts` (see docker/compose.vm.yml). */
import { loadConfig } from "@events-qr/web/server/config";
import { buildContext } from "@events-qr/web/server/context";
import { drainEmailQueue } from "./emailQueue";
import { GmailSender } from "./gmail";
import { cleanupSigningKeys, KEY_CLEANUP_INTERVAL_MS } from "./keyCleanup";
import { RETENTION_CHECK_INTERVAL_MS, retentionDue, runRetention } from "./retention";
import { SmtpSender } from "./smtp";

const config = loadConfig();
if (config.APP_MODE === "hub") {
  const { hubMain } = await import("./hubMain");
  await hubMain(config);
  process.exit(0);
}

const ctx = await buildContext(config);
const sender = makeSender(ctx.config);
const from = sender.address;

function makeSender(c: typeof config): GmailSender | SmtpSender {
  if (c.MAIL_TRANSPORT === "smtp") {
    if (!c.SMTP_HOST || !c.MAIL_FROM) {
      console.error("worker: MAIL_TRANSPORT=smtp needs SMTP_HOST and MAIL_FROM");
      process.exit(1);
    }
    return new SmtpSender({ host: c.SMTP_HOST, port: c.SMTP_PORT, sender: c.MAIL_FROM });
  }
  if (!c.GMAIL_SA_KEY_PATH || !c.GMAIL_SENDER) {
    console.error("worker: GMAIL_SA_KEY_PATH and GMAIL_SENDER must be set");
    process.exit(1);
  }
  return new GmailSender({ keyPath: c.GMAIL_SA_KEY_PATH, sender: c.GMAIL_SENDER });
}

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
  `worker: sending as ${from} via ${ctx.config.MAIL_TRANSPORT}, up to ${ctx.config.EMAIL_DAILY_LIMIT} emails per 24 h` +
    (ctx.config.INSTANCE_LABEL ? ` (instance ${ctx.config.INSTANCE_LABEL})` : ""),
);
while (!stopping) {
  try {
    const r = await drainEmailQueue({ ctx, sender, from });
    if (r.sent || r.failed || r.retried || r.throttled) console.log("worker: email pass", r);
  } catch (err) {
    console.error("worker: email pass failed", err);
  }
  await new Promise((resolve) => setTimeout(resolve, ctx.config.WORKER_POLL_SECONDS * 1000));
}
process.exit(0);
