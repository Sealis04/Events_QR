import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { defineConfig } from "@playwright/test";

/**
 * Browser tests run against a production build (`next build` + `next start`) with its own
 * throwaway database (`<DB_NAME>_test_e2e`) and signing key, created by e2e/prepare.ts.
 * DB credentials come from the repo-root .env, as for the unit tests.
 */
const envFile = resolve(import.meta.dirname, "../../.env");
const base = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
const PORT = 3100;
/** The venue hub: the same build with APP_MODE=hub, its own SQLite file, none of the VM's secrets. */
const HUB_PORT = 3200;

// The sandbox ships one Chromium; use it when Playwright's own download is absent.
const sandboxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    serviceWorkers: "allow",
    launchOptions: {
      executablePath: existsSync(sandboxChrome) ? sandboxChrome : undefined,
      args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
    },
  },
  webServer: [
    {
      command: `bun e2e/prepare.ts && node node_modules/next/dist/bin/next build && node node_modules/next/dist/bin/next start -p ${PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        ...(base as Record<string, string>),
        ...(process.env as Record<string, string>),
        NODE_ENV: "production",
        COOKIE_SECURE: "false",
        DB_NAME: `${base.DB_NAME ?? process.env.DB_NAME ?? "events_qr"}_test_e2e`,
        SIGNING_KEY_PATH: resolve(import.meta.dirname, "e2e/.tmp/signing-key.json"),
        SIGNING_KEY_PASSPHRASE: "e2e-passphrase",
        SESSION_SECRET: "e2e".repeat(16),
        EVENT_KEY_MASTER: "ab".repeat(32),
        SYNC_HORIZON_SECONDS: "1",
        // Hub setup page, step 2: fixed answers instead of a public DNS lookup (a private address,
        // a Cloudflare one, and no record at all).
        HUB_CHECK_DNS_ANSWERS:
          "hub.e2e.test=192.168.50.10,hub.cf.test=104.21.5.9;172.67.1.1,hub.none.test=",
      },
    },
    {
      // Starts after the VM is ready (so the build exists) and gets only what a hub may have.
      command: `bun e2e/prepare-hub.ts && node node_modules/next/dist/bin/next start -p ${HUB_PORT} -H 127.0.0.1`,
      url: `http://127.0.0.1:${HUB_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        ...hubEnv(process.env as Record<string, string>),
        NODE_ENV: "production",
        APP_MODE: "hub",
        COOKIE_SECURE: "false",
        HUB_DB_PATH: resolve(import.meta.dirname, "e2e/.tmp/hub.sqlite"),
        // The server the hub's /setup page links to (the VM directly, no proxy).
        HUB_SERVER_URL: `http://127.0.0.1:${PORT}`,
        // A throwaway certificate for the hub's health page to report an expiry date from.
        HUB_CERT_PATH: resolve(import.meta.dirname, "e2e/.tmp/hub-cert.pem"),
        SYNC_HORIZON_SECONDS: "1",
      },
    },
  ],
});

/** The process environment without the VM's database, signing and session secrets. */
function hubEnv(env: Record<string, string>): Record<string, string> {
  const secret = /^(DB_|SIGNING_|EVENT_KEY_|SESSION_SECRET|GMAIL_|PUBLIC_URL|HUB_URL)/;
  return Object.fromEntries(Object.entries(env).filter(([k]) => !secret.test(k)));
}
