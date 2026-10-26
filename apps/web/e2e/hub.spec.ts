import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { decodeSetupCode, encodeSetupCode } from "../../../packages/core/src/setup";
import { E2E_PIN } from "./constants";
import { SwitchProxy } from "./proxy";

/**
 * The venue hub in a real browser: a phone served by the VM, enrolled at the hub, scanning
 * through the hub, falling back to the VM when the hub goes quiet, and the hub keeping its
 * promise with the uplink cut. Three real servers: the VM (:3100), the hub (:3200) and the hub's
 * sync worker, with two switchable proxies standing in for the two network paths:
 *
 *   phone -> :3201 (proxy) -> hub :3200        "the hub"
 *   hub   -> :3101 (proxy) -> VM  :3100        "the hub's uplink" (also the VM address the phone learns)
 */
const VM = "http://127.0.0.1:3100";
const HUB = "http://127.0.0.1:3200";
const PHONE_TO_HUB = 3201;
const UPLINK = 3101;
const root = resolve(import.meta.dirname, "../../..");
const hubDb = resolve(import.meta.dirname, ".tmp/hub.sqlite");

const hubProxy = new SwitchProxy(PHONE_TO_HUB, 3200);
const uplink = new SwitchProxy(UPLINK, 3100);
let worker: ChildProcess | undefined;
let supervisor: APIRequestContext;
let eventId: number;

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: VM });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function admitted(): Promise<number> {
  const res = await supervisor.get(`/api/events/${eventId}/stats`);
  return (await res.json()).total_admitted as number;
}

async function newTicket(holder: string, ticketType = 0) {
  const staff = await loggedIn("e2e-staff");
  const res = await staff.post(`/api/events/${eventId}/tickets`, {
    data: {
      idempotency_key: `hub-${Date.now()}-${Math.random()}`,
      ticket_type: ticketType,
      holder_name: holder,
    },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).tickets[0].token as string;
}

/** A setup QR whose hub address is the phone's path to the hub (the VM would print its HUB_URL). */
async function setupQr(direction = "entry") {
  const res = await supervisor.post("/api/devices/enroll", {
    data: { event_id: eventId, gate: "Gate A", direction, label: "hub phone" },
  });
  expect(res.status()).toBe(201);
  const decoded = decodeSetupCode((await res.json()).setup_qr);
  if (!decoded.ok) throw new Error("bad setup qr");
  return encodeSetupCode({ ...decoded.setup, hubUrl: `http://127.0.0.1:${PHONE_TO_HUB}` });
}

const feed = (page: Page, raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);
const settle = (ms = 2600) => new Promise((resolve) => setTimeout(resolve, ms)); // two 1 s sync cycles

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await hubProxy.start();
  await uplink.start();
  supervisor = await loggedIn("e2e-super");
  eventId = (await (await supervisor.get("/api/events")).json()).find(
    (e: { name: string }) => e.name === "E2E Fest",
  ).id;

  // Bind the hub to the event, through its uplink, exactly as an operator would.
  const setup = await supervisor.post("/api/hubs/setup", {
    data: { event_id: eventId, label: "e2e hub" },
  });
  expect(setup.status()).toBe(201);
  const hubEnv = {
    ...process.env,
    HUB_DB_PATH: hubDb,
    APP_MODE: "hub",
    SYNC_HORIZON_SECONDS: "1",
  };
  // Asynchronous on purpose: the proxy the hub reaches the VM through runs in this very process.
  await promisify(execFile)(
    "bun",
    ["scripts/hub-enroll.ts", `http://127.0.0.1:${UPLINK}`, (await setup.json()).setup_code],
    {
      cwd: root,
      env: hubEnv,
    },
  );
  worker = spawn("bun", ["apps/worker/src/main.ts"], {
    cwd: root,
    env: {
      ...hubEnv,
      HUB_TICKET_PULL_SECONDS: "1",
      HUB_SCAN_PUSH_SECONDS: "1",
      HUB_MAX_BACKOFF_SECONDS: "2",
      HUB_VM_TIMEOUT_SECONDS: "2",
    },
    stdio: "inherit",
  });
});

test.afterAll(async () => {
  worker?.kill("SIGTERM");
  await hubProxy.stop();
  await uplink.stop();
});

test("the hub serves the scanner and the read-only dashboard only, and holds no signing secret", async () => {
  const anon = await playwrightRequest.newContext({ baseURL: HUB });
  expect((await anon.get("/api/health")).ok()).toBe(true);
  expect((await anon.get("/api/health")).headers()["access-control-allow-origin"]).toBe("*");
  for (const path of ["/api/staff", "/api/sync/tickets", "/api/sync/meta", "/api/events/1/staff"]) {
    expect((await anon.get(path)).status(), path).toBe(404);
  }
  // The read-only dashboard is served, but only to a logged-in supervisor or admin.
  expect((await anon.get("/api/events")).status()).toBe(401);
  expect((await anon.get(`/api/events/${eventId}/stats`)).status()).toBe(401);
  expect((await anon.get("/login")).status()).toBe(200);
  expect((await anon.post("/api/hubs/setup", { data: {} })).status()).toBe(404);
  const admin = await loggedIn("e2e-admin");
  const cookie = (await admin.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const withSession = await anon.post(`/api/events/${eventId}/tickets`, {
    headers: { cookie },
    data: { idempotency_key: "k".repeat(10), ticket_type: 0, holder_name: "x" },
  });
  expect(withSession.status()).toBe(404); // even a valid VM session cannot issue at the hub

  // Nothing the VM keeps secret is in the hub's database.
  // Public keys are the hub's to hold; the encrypted secrets and their salt are not.
  const key = JSON.parse(
    readFileSync(resolve(import.meta.dirname, ".tmp/signing-key.json"), "utf8"),
  ) as { kdf: { salt: string }; keys: { public_key: string; secret: string }[] };
  const secrets = [key.kdf.salt, ...key.keys.map((k) => k.secret)];
  expect(secrets.every((v) => v.length >= 16)).toBe(true);
  const bytes =
    readFileSync(hubDb).toString("latin1") + readFileSync(`${hubDb}-wal`).toString("latin1");
  for (const secret of secrets) expect(bytes).not.toContain(secret);
  for (const k of key.keys) expect(bytes).toContain(k.public_key); // the bundle does carry the public key
  expect(bytes).not.toContain("e2e-passphrase");
});

test("a phone enrolled at the hub shows the Hub pill and admits through it; with the hub quiet the next scan goes to the VM (VM only) and the hub is used again once it answers", async ({
  page,
}) => {
  const first = await newTicket("Hub Hannah");
  const second = await newTicket("Cloud Carl");
  const third = await newTicket("Hub Again");
  const qr = await setupQr();
  await settle(); // the hub pulls the tickets and the new enrolment code

  await page.goto("/scan");
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, qr);
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();
  await expect(page.getByTestId("pill")).toContainText("Hub");
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "hub");

  // Admitted by the hub (the VM is told by the hub's push, within a second or two).
  const before = await admitted();
  await feed(page, first);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result-holder")).toHaveText("Hub Hannah");
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "hub");
  await expect.poll(admitted, { timeout: 15_000 }).toBe(before + 1);
  await expect(page.getByTestId("result")).toBeHidden({ timeout: 5000 });

  // The hub goes quiet. The phone waits 800 ms, asks the VM, and says VM only.
  hubProxy.mode = "hang";
  await settle(1300); // the VM must have heard of this phone (the hub pushed it) before it is needed
  const started = Date.now();
  await feed(page, second);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result-holder")).toHaveText("Cloud Carl");
  expect(Date.now() - started).toBeLessThan(5000);
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "cloud");
  await expect(page.getByTestId("pill")).toContainText("VM only");
  await expect.poll(admitted, { timeout: 10_000 }).toBe(before + 2); // decided by the VM itself
  await expect(page.getByTestId("result")).toBeHidden({ timeout: 5000 });

  // The hub answers again: the very next scan uses it.
  hubProxy.mode = "up";
  await page.waitForTimeout(3200);
  await feed(page, third);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "hub");
  await expect.poll(admitted, { timeout: 15_000 }).toBe(before + 3);
});

test("with the hub's uplink cut the hub keeps admitting, and when it is back the scan reaches the VM exactly once", async ({
  page,
}) => {
  const ticket = await newTicket("Uplink Ulla");
  const other = await newTicket("Uplink Uri");
  const qr = await setupQr();
  await settle();

  await page.goto("/scan");
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, qr);
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();

  uplink.mode = "down";
  await settle(1500);
  const before = await admitted();
  await feed(page, ticket);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "hub");
  await expect(page.getByTestId("result")).toBeHidden({ timeout: 5000 });
  await page.waitForTimeout(3200);
  await feed(page, ticket);
  await expect(page.getByTestId("result-title")).toHaveText("ALREADY USED"); // the hub is the authority
  await page.getByTestId("result").click();
  await page.waitForTimeout(3200);
  expect(await admitted()).toBe(before); // the VM has heard nothing

  uplink.mode = "up";
  await expect.poll(admitted, { timeout: 20_000 }).toBe(before + 1);
  await page.waitForTimeout(3000);
  expect(await admitted()).toBe(before + 1); // uploaded once, not repeatedly
  await feed(page, other);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
});

test("the hub dashboard works with the VM unreachable: a supervisor logs in, sees the check-in and devices, and admits manually", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const scanned = await newTicket("Hub Dash Dan");
  await newTicket("Hub Dash Dora");
  const qr = await setupQr();
  await settle();

  // A phone admits Dan through the hub.
  const phoneContext = await browser.newContext({ baseURL: VM });
  const phone = await phoneContext.newPage();
  await phone.goto("/scan");
  await phone.waitForFunction(() => !!window.__scannerFeed);
  await feed(phone, qr);
  await expect(phone.getByTestId("ready")).toHaveText("Gate A · Entry");
  await phone.getByPlaceholder("Name").fill("e2e-staff");
  await phone.getByPlaceholder("PIN").fill(E2E_PIN);
  await phone.getByRole("button", { name: "Log in" }).click();
  await expect(phone.locator("main[data-phase=scan]")).toBeVisible();
  await feed(phone, scanned);
  await expect(phone.getByTestId("result")).toHaveAttribute("data-tone", "green");

  // The VM becomes unreachable for the hub, and the dashboard is used on the hub alone.
  uplink.mode = "down";
  await settle(1500);
  await page.goto(`${HUB}/login`);
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByText(/only lets supervisors and admins/)).toBeVisible(); // plain staff: no dashboard session
  await page.getByPlaceholder("Name").fill("e2e-super");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${HUB}/events/\\d+`));
  await expect(page.getByTestId("server-mode")).toHaveText("Hub");
  await expect(page.getByTestId("who")).toContainText("e2e-super");

  // Issuance and setup are shown disabled; stats, devices and search work.
  await expect(page.locator(".tabs .disabled")).toHaveCount(1); // supervisors do not see Setup at all
  const stats = await (await page.request.get(`${HUB}/api/events/${eventId}/stats`)).json();
  expect(stats.total_admitted).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("stat-total")).toHaveText(String(stats.total_admitted));
  await page.getByRole("link", { name: "Devices" }).click();
  await expect(page.getByTestId("device-table")).toContainText("hub phone");
  await page.getByRole("link", { name: "Conflicts" }).click();
  await expect(page.getByTestId("conflicts")).toBeVisible();

  await page.getByRole("link", { name: "Attendees & overrides" }).click();
  await page.getByLabel("Find an attendee").fill("Hub Dash Dora");
  await page.getByTestId("attendees").getByRole("button", { name: "Admit" }).click();
  await page.getByLabel("Supervisor PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Confirm admit" }).click();
  await expect(page.getByText(/Admitted \(logged as an override\)/)).toBeVisible();
  await expect(page.getByTestId("overrides")).toContainText("e2e-super");
  const after = await (await page.request.get(`${HUB}/api/events/${eventId}/stats`)).json();
  expect(after.total_admitted).toBe(stats.total_admitted + 1);

  // The VM has heard nothing yet; when the uplink returns the manual admit arrives once.
  const vmCount = async () =>
    (await (await supervisor.get(`/api/events/${eventId}/overrides`)).json()).overrides.length;
  const vmBefore = await vmCount();
  uplink.mode = "up";
  await expect.poll(vmCount, { timeout: 20_000 }).toBeGreaterThan(vmBefore);
  await phoneContext.close();
});

test("'Pull tickets now' on the hub dashboard: reports an unreachable VM, is rate-limited, then pulls", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto(`${HUB}/login`);
  await page.getByPlaceholder("Name").fill("e2e-super");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(new RegExp(`${HUB}/events/\\d+`));
  const result = page.getByTestId("pull-now-result");
  const button = page.getByRole("button", { name: "Pull tickets now" });

  uplink.mode = "down";
  await settle(1500);
  await button.click();
  await expect(result).toContainText("Last successful pull:");
  await expect(result).not.toContainText("Pulled");

  // A second press within 10 s is refused with the wait.
  await button.click();
  await expect(result).toContainText(/Try again in \d+ s/);

  uplink.mode = "up";
  await settle(11_000);
  await button.click();
  await expect(result).toContainText(/Pulled \d+ changes? from the VM/);
});
