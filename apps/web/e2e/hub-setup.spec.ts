import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { decodeSetupCode } from "../../../packages/core/src/setup";
import { E2E_PIN } from "./constants";
import { SwitchProxy } from "./proxy";

/**
 * M12: an IT person takes a fresh hub from step 1 to step 8 using only the Hub setup page, with
 * real processes: the VM (:3100), the hub (:3200) and the hub's sync worker. Part 1 runs on the
 * VM's page, Part 2 on the hub's own page (a second browser, as at the venue). Every step is made
 * to fail once, and the fix text is read, before it passes.
 *
 * Fakes, and why: public DNS (the VM's `HUB_CHECK_DNS_ANSWERS` hook gives `hub.e2e.test` a private
 * address, `hub.cf.test` Cloudflare's and `hub.none.test` none) and the hub's HTTPS name (the
 * browser's requests to https://hub.e2e.test are routed to the real hub on :3200). The hub's
 * uplink is a switchable proxy (:3101) standing in for the venue's internet cable.
 */
const VM = "http://127.0.0.1:3100";
const HUB = "http://127.0.0.1:3200";
const UPLINK = 3101;
const root = resolve(import.meta.dirname, "../../..");
const hubDb = resolve(import.meta.dirname, ".tmp/hub.sqlite");
const SHOTS = resolve(root, "plans/m12-hub-setup/screenshots");

const uplink = new SwitchProxy(UPLINK, 3100);
let worker: ChildProcess | undefined;
let vmContext: BrowserContext;
let hubContext: BrowserContext;
let vmPage: Page;
let hubPage: Page;
let eventId: number;

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: VM });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function login(page: Page, origin: string, name: string) {
  await page.goto(`${origin}/login`);
  await page.getByPlaceholder("Name").fill(name);
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("who")).toContainText(name);
}

/** What https://hub.e2e.test answers: the real hub, the VM (a wrong target), or nothing. */
const named: { mode: "hub" | "vm" | "down" } = { mode: "hub" };
async function routeHubName(page: Page) {
  await page.route("https://hub.e2e.test/**", async (route) => {
    if (named.mode === "down") return route.abort("connectionrefused");
    const url = new URL(route.request().url());
    const target = named.mode === "hub" ? HUB : VM;
    const res = await route.fetch({ url: `${target}${url.pathname}${url.search}` });
    await route.fulfill({
      response: res,
      headers: { ...res.headers(), "access-control-allow-origin": "*" },
    });
  });
}

const step = (page: Page, key: string) => page.getByTestId(`step-${key}`);
const runCheck = (page: Page, key: string) =>
  step(page, key)
    .getByRole("button", { name: /^Check:/ })
    .click();
const expectResult = (page: Page, key: string, result: string) =>
  expect(step(page, key)).toHaveAttribute("data-result", result);
const expectCode = (page: Page, key: string, code: string) =>
  expect(step(page, key).getByTestId("step-result")).toHaveAttribute("data-code", code);
const setAddress = (page: Page, value: string) => page.getByLabel(/Hub address/).fill(value);
const settle = (ms = 2600) => new Promise((resolve) => setTimeout(resolve, ms));

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  await uplink.start();
  const admin = await loggedIn("e2e-admin");
  eventId = (await (await admin.get("/api/events")).json()).find(
    (e: { name: string }) => e.name === "E2E Fest",
  ).id;
  // Separate browsers: both sites are 127.0.0.1 and would otherwise share one session cookie.
  vmContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  hubContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  vmPage = await vmContext.newPage();
  hubPage = await hubContext.newPage();
  await routeHubName(vmPage);
  await routeHubName(hubPage);
});

test.afterAll(async () => {
  worker?.kill("SIGTERM");
  await uplink.stop();
  await vmContext?.close();
  await hubContext?.close();
});

test("Part 1 at the office: each step fails with its fix, then passes", async () => {
  test.setTimeout(180_000);
  await login(vmPage, VM, "e2e-admin");
  await vmPage.goto(`${VM}/events/${eventId}?tab=hub-setup`);
  await expect(vmPage.getByTestId("hub-setup")).toBeVisible();
  await expect(vmPage.getByTestId("hub-progress")).toContainText("0 of 8 passed");
  await expect(vmPage.getByRole("heading", { name: /Part 1 · At the office/ })).toBeVisible();
  await expect(vmPage.getByRole("heading", { name: /Part 2 · At the venue/ })).toBeVisible();
  await setAddress(vmPage, "https://hub.e2e.test");

  // 1. Hub running: down first (the three usual causes), then up.
  named.mode = "down";
  await runCheck(vmPage, "hub_running");
  await expectResult(vmPage, "hub_running", "fail");
  await expectCode(vmPage, "hub_running", "hub_unreachable");
  await expect(step(vmPage, "hub_running").getByTestId("step-fix")).toContainText(
    "hub stack is not up",
  );
  named.mode = "vm";
  await runCheck(vmPage, "hub_running");
  await expectCode(vmPage, "hub_running", "not_hub_mode");
  named.mode = "hub";
  await runCheck(vmPage, "hub_running");
  await expectResult(vmPage, "hub_running", "pass");
  await expect(vmPage.getByTestId("hub-progress")).toContainText("1 of 8 passed");

  // 2. The record: Cloudflare, none, then a private address.
  await setAddress(vmPage, "https://hub.cf.test");
  await runCheck(vmPage, "dns_record");
  await expectResult(vmPage, "dns_record", "fail");
  await expect(step(vmPage, "dns_record").getByTestId("step-fix")).toContainText(
    "turn the cloud grey",
  );
  await setAddress(vmPage, "https://hub.none.test");
  await runCheck(vmPage, "dns_record");
  await expectCode(vmPage, "dns_record", "dns_no_record");
  await setAddress(vmPage, "https://hub.e2e.test");
  await runCheck(vmPage, "dns_record");
  await expectResult(vmPage, "dns_record", "pass");
  await expect(step(vmPage, "dns_record")).toContainText("192.168.50.10");

  // 3. Certificate: unreachable over https, then valid with its expiry from the hub.
  named.mode = "down";
  await runCheck(vmPage, "certificate");
  await expectCode(vmPage, "certificate", "cert_unverified");
  named.mode = "hub";
  await runCheck(vmPage, "certificate");
  await expectResult(vmPage, "certificate", "pass");
  await expect(step(vmPage, "certificate")).toContainText(/Days left\s*(89|90)/);

  // 4. Link the hub: not linked yet, then a setup code and the real enrolment command.
  await runCheck(vmPage, "link_hub");
  await expectResult(vmPage, "link_hub", "fail");
  await step(vmPage, "link_hub").getByRole("button", { name: "Make a setup code" }).click();
  const command = await step(vmPage, "link_hub").locator(".cmd code").last().innerText();
  expect(command).toContain("hub-enroll.ts");
  const setupCode = command.trim().split(/\s+/).at(-1)!;
  // On the hub machine (through the hub's uplink, so it can be cut later).
  await promisify(execFile)(
    "bun",
    ["scripts/hub-enroll.ts", `http://127.0.0.1:${UPLINK}`, setupCode],
    {
      cwd: root,
      env: { ...process.env, HUB_DB_PATH: hubDb, APP_MODE: "hub", SYNC_HORIZON_SECONDS: "1" },
    },
  );
  worker = spawn("bun", ["apps/worker/src/main.ts"], {
    cwd: root,
    env: {
      ...process.env,
      HUB_DB_PATH: hubDb,
      APP_MODE: "hub",
      SYNC_HORIZON_SECONDS: "1",
      HUB_TICKET_PULL_SECONDS: "1",
      HUB_SCAN_PUSH_SECONDS: "1",
      HUB_MAX_BACKOFF_SECONDS: "2",
      HUB_VM_TIMEOUT_SECONDS: "2",
    },
    stdio: "inherit",
  });
  await runCheck(vmPage, "link_hub");
  await expectResult(vmPage, "link_hub", "pass");
  await expect(vmPage.getByTestId("hub-progress")).toContainText("4 of 8 passed");

  // The venue steps are not run from here.
  await expect(step(vmPage, "data_match")).toContainText("runs on the hub's own dashboard");
  await expect(step(vmPage, "data_match").getByRole("button", { name: /^Check:/ })).toHaveCount(0);
});

test("Part 2 at the venue, on the hub's own page", async () => {
  test.setTimeout(240_000);
  await login(hubPage, HUB, "e2e-admin");
  await hubPage.goto(`${HUB}/events/${eventId}?tab=hub-setup`);
  await expect(hubPage.getByTestId("hub-setup")).toBeVisible();
  // Steps that need the VM say so on the hub.
  await expect(step(hubPage, "dns_record")).toContainText("needs the VM");
  await expect(step(hubPage, "link_hub")).toContainText("needs the VM");
  await setAddress(hubPage, "https://hub.e2e.test");

  // 5. Local DNS: nothing answers, then the name leads to the VM, then to the hub.
  named.mode = "down";
  await runCheck(hubPage, "local_dns");
  await expectCode(hubPage, "local_dns", "local_dns_unreachable");
  await expect(step(hubPage, "local_dns").getByTestId("step-fix")).toContainText("nslookup");
  named.mode = "vm";
  await runCheck(hubPage, "local_dns");
  await expectCode(hubPage, "local_dns", "local_dns_wrong_target");
  named.mode = "hub";
  await runCheck(hubPage, "local_dns");
  await expectResult(hubPage, "local_dns", "pass");

  // 6. Tickets and staff match; with the VM unreachable the step is skipped, not failed.
  const staff = await loggedIn("e2e-staff");
  await staff.post(`/api/events/${eventId}/tickets`, {
    data: { idempotency_key: `m12-${Date.now()}`, ticket_type: 0, holder_name: "Counted" },
  });
  await settle();
  await runCheck(hubPage, "data_match");
  await expectResult(hubPage, "data_match", "pass");
  uplink.mode = "down";
  await settle(1500);
  await runCheck(hubPage, "data_match");
  await expect(step(hubPage, "data_match").getByTestId("step-result")).toContainText(
    "could not be asked",
  );
  await expect(step(hubPage, "data_match").getByText("Skipped")).toBeVisible();
  uplink.mode = "up";

  // 7. A phone: none through the hub yet, then one enrolled at the hub that reports.
  await runCheck(hubPage, "phone_via_hub");
  await expectResult(hubPage, "phone_via_hub", "fail");
  const supervisor = await loggedIn("e2e-super");
  const setup = await supervisor.post("/api/devices/enroll", {
    data: { event_id: eventId, gate: "Gate A", direction: "entry", label: "hub setup phone" },
  });
  const decoded = decodeSetupCode((await setup.json()).setup_qr);
  if (!decoded.ok) throw new Error("bad setup qr");
  await settle(); // the hub's pull brings the unused code
  const deviceId = crypto.randomUUID();
  const enrolled = await playwrightRequest.newContext({ baseURL: HUB });
  const exchange = await enrolled.post("/api/enroll", {
    data: { code: decoded.setup.code, device_id: deviceId },
  });
  expect(exchange.status()).toBe(200);
  const phoneToken = (await exchange.json()).device_token as string;
  const beat = await enrolled.post("/api/devices/heartbeat", {
    headers: { authorization: `Bearer ${phoneToken}` },
    data: { outbox_size: 0 },
  });
  expect(beat.ok()).toBe(true);
  await runCheck(hubPage, "phone_via_hub");
  await expectResult(hubPage, "phone_via_hub", "pass");

  // 8. Offline scan: not started, started but the cable still in, then the real thing.
  await runCheck(hubPage, "offline_scan");
  await expectCode(hubPage, "offline_scan", "offline_not_tested");
  await step(hubPage, "offline_scan")
    .getByRole("button", { name: "Start the offline test" })
    .click();
  await expect(hubPage.getByTestId("offline-started")).toBeVisible();
  await runCheck(hubPage, "offline_scan");
  await expectCode(hubPage, "offline_scan", "offline_no_outage");

  const rehearsal = await staff.post(`/api/events/${eventId}/tickets`, {
    data: { idempotency_key: `m12-r-${Date.now()}`, ticket_type: 0, holder_name: "Rehearsal" },
  });
  const ticketId = (await rehearsal.json()).tickets[0].ticket_id as string;
  await settle();
  uplink.mode = "down"; // the cable is out
  await settle(4000); // the hub's next pull fails and notices
  const claim = await enrolled.post("/api/claim", {
    headers: { authorization: `Bearer ${phoneToken}` },
    data: {
      scan_id: crypto.randomUUID(),
      ticket_id: ticketId,
      device_id: deviceId,
      gate: "Gate A",
      scanned_at: Math.floor(Date.now() / 1000),
    },
  });
  expect(claim.status()).toBe(200);
  expect((await claim.json()).result).toBe("admitted");
  await runCheck(hubPage, "offline_scan");
  await expectCode(hubPage, "offline_scan", "offline_not_delivered");
  await expect(step(hubPage, "offline_scan").getByTestId("step-fix")).toContainText(
    "Plug the uplink",
  );
  uplink.mode = "up"; // cable back in
  await settle(4000);
  await runCheck(hubPage, "offline_scan");
  await expectResult(hubPage, "offline_scan", "pass");
  await expect(hubPage.getByTestId("hub-progress")).toContainText("4 of 8 passed");
});

test("the hub's results reach the VM's record, and the page shows 8 of 8", async () => {
  test.setTimeout(60_000);
  await vmPage.goto(`${VM}/events/${eventId}?tab=hub-setup`);
  // The hub uploads its results with its next push; the page also refreshes itself every 15 s.
  await expect(async () => {
    await vmPage.reload();
    await expect(vmPage.getByTestId("hub-progress")).toContainText("8 of 8 passed", {
      timeout: 3000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(step(vmPage, "offline_scan")).toContainText("on the hub");
  await expect(step(vmPage, "local_dns")).toContainText("by e2e-admin");
  await vmPage.getByText(/Record of checks/).click();
  await expect(vmPage.getByText("A scan works with the internet unplugged").last()).toBeVisible();

  if (process.env.SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await vmPage.screenshot({ path: `${SHOTS}/hub-setup-desktop.png`, fullPage: true });
    await vmPage.setViewportSize({ width: 390, height: 844 });
    await vmPage.waitForTimeout(300);
    await vmPage.screenshot({ path: `${SHOTS}/hub-setup-phone.png`, fullPage: true });
    await hubPage.screenshot({ path: `${SHOTS}/hub-setup-on-hub-desktop.png`, fullPage: true });
    await hubPage.setViewportSize({ width: 390, height: 844 });
    await hubPage.waitForTimeout(300);
    await hubPage.screenshot({ path: `${SHOTS}/hub-setup-on-hub-phone.png`, fullPage: true });
  }
});
