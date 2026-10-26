import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chromium,
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { sessionExpiry } from "../src/scanner/session";
import { E2E_PIN } from "./constants";

/**
 * M11: the phone login lasts. It is kept in the phone's encrypted IndexedDB, so it survives a
 * reload and a browser restart (a persistent profile closed and reopened), online and offline;
 * it ends on sign-out and at the cut-off (next 05:00 event-local time or the event end).
 */
const BASE = "http://127.0.0.1:3100";
const sandboxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function eventFacts(ctx: APIRequestContext) {
  const events = await (await ctx.get("/api/events")).json();
  const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
  const ev = await (await ctx.get(`/api/events/${id}`)).json();
  return { id, dayZero: ev.day_zero as number, endsAt: ev.ends_at as number };
}

async function setupQr(): Promise<{ qr: string; dayZero: number; endsAt: number }> {
  const supervisor = await loggedIn("e2e-super");
  const facts = await eventFacts(supervisor);
  const res = await supervisor.post("/api/devices/enroll", {
    data: { event_id: facts.id, gate: "Gate A", direction: "entry", label: "session phone" },
  });
  expect(res.status()).toBe(201);
  return { qr: (await res.json()).setup_qr as string, ...facts };
}

/** A browser profile on disk: closing it and opening the same folder again is a browser restart. */
async function openProfile(
  dir: string,
  skewMs = 0,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await chromium.launchPersistentContext(dir, {
    baseURL: BASE,
    executablePath: existsSync(sandboxChrome) ? sandboxChrome : undefined,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  // The phone's clock runs `skewMs` ahead of real time (tests the cut-off without waiting for it).
  await context.addInitScript((skew: number) => {
    if (!skew) return;
    const Real = Date;
    const shifted = () => Real.now() + skew;
    class Skewed extends Real {
      constructor(...args: unknown[]) {
        super(...((args.length ? args : [shifted()]) as [number]));
      }
      static override now() {
        return shifted();
      }
    }
    window.Date = Skewed as DateConstructor;
  }, skewMs);
  const page = context.pages()[0] ?? (await context.newPage());
  return { context, page };
}

const feed = (page: Page, raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);
const scanning = (page: Page) => page.locator("main[data-phase=scan]");
const loginScreen = (page: Page) => page.locator("main[data-phase=login]");

async function logIn(page: Page) {
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(scanning(page)).toBeVisible();
}

test("the staff login survives a reload, a browser restart and no network; sign out ends it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-profile-"));
  try {
    const { qr } = await setupQr();
    let { context, page } = await openProfile(dir);
    await page.goto("/scan");
    await page.waitForFunction(() => !!window.__scannerFeed);
    await feed(page, qr);
    await expect(loginScreen(page)).toBeVisible();
    await logIn(page);
    // The service worker holds the shell and the decoder before the network goes away.
    await page.waitForFunction(async () => {
      if (!navigator.serviceWorker.controller) return false;
      const assets = await caches.open("scan-assets-v1");
      return (await assets.keys()).some((r) => r.url.endsWith(".wasm"));
    });

    await page.reload();
    await expect(scanning(page)).toBeVisible(); // reload: still logged in

    await context.close();
    ({ context, page } = await openProfile(dir));
    await page.goto("/scan");
    await expect(scanning(page)).toBeVisible(); // browser restart: still logged in

    await context.setOffline(true);
    await page.reload();
    await expect(scanning(page)).toBeVisible(); // restart-style reload with no network
    await context.setOffline(false);

    // Sign out ends it for good: a reload asks for the PIN again.
    await page.getByRole("button", { name: "Menu" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(loginScreen(page)).toBeVisible();
    await page.reload();
    await expect(loginScreen(page)).toBeVisible();
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the login ends at the cut-off (next 05:00 event time or the event end), not before", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scanner-profile-"));
  try {
    const { qr, dayZero, endsAt } = await setupQr();
    let { context, page } = await openProfile(dir);
    await page.goto("/scan");
    await page.waitForFunction(() => !!window.__scannerFeed);
    await feed(page, qr);
    await logIn(page);
    const cutoff = sessionExpiry(Math.floor(Date.now() / 1000), dayZero, endsAt);
    const nowSec = () => Math.floor(Date.now() / 1000);
    await context.close();

    // A minute before the cut-off: still logged in.
    ({ context, page } = await openProfile(dir, (cutoff - 60 - nowSec()) * 1000));
    await page.goto("/scan");
    await expect(scanning(page)).toBeVisible();
    await context.close();

    // A minute after it: asked again (the saved login is deleted, not just hidden).
    ({ context, page } = await openProfile(dir, (cutoff + 60 - nowSec()) * 1000));
    await page.goto("/scan");
    await expect(loginScreen(page)).toBeVisible();
    await context.close();

    // Back on the real clock the login is gone: it had to be entered again.
    ({ context, page } = await openProfile(dir));
    await page.goto("/scan");
    await expect(loginScreen(page)).toBeVisible();
    await context.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
