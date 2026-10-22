import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_PIN } from "./constants";

/**
 * M5 in a real browser: enrol, lose the network entirely, keep admitting on the phone alone (with
 * the orange OFFLINE banner), survive a reload with the outbox intact, log a member of staff in
 * with no network, then get the network back and watch the outbox drain into the VM.
 */
const BASE = "http://127.0.0.1:3100";

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function eventId(ctx: APIRequestContext): Promise<number> {
  const events = await (await ctx.get("/api/events")).json();
  return events.find((e: { name: string }) => e.name === "E2E Fest").id;
}

async function admitted(): Promise<number> {
  const sup = await loggedIn("e2e-super");
  const res = await sup.get(`/api/events/${await eventId(sup)}/stats`);
  return (await res.json()).total_admitted as number;
}

async function conflicts(): Promise<number> {
  const sup = await loggedIn("e2e-super");
  const res = await sup.get(`/api/events/${await eventId(sup)}/conflicts`);
  expect(res.status()).toBe(200);
  return (await res.json()).total as number;
}

async function newTicket(holder: string) {
  const staff = await loggedIn("e2e-staff");
  const res = await staff.post(`/api/events/${await eventId(staff)}/tickets`, {
    data: {
      idempotency_key: `offline-${Date.now()}-${Math.random()}`,
      ticket_type: 0,
      holder_name: holder,
    },
  });
  expect(res.status()).toBe(201);
  await new Promise((resolve) => setTimeout(resolve, 1100)); // the sync horizon
  return (await res.json()).tickets[0].token as string;
}

const feed = (page: Page, raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);

test("offline: admit with the OFFLINE banner, 'Already inside (offline)', reload keeps the outbox, offline staff login, then the outbox drains to the VM", async ({
  page,
  context,
}) => {
  const ticket = await newTicket("Offline Olga");
  const other = await newTicket("Offline Otto");

  // Enrol and log in while the network is up.
  const sup = await loggedIn("e2e-super");
  const setup = await sup.post("/api/devices/enroll", {
    data: {
      event_id: await eventId(sup),
      gate: "Gate A",
      direction: "entry",
      label: "offline phone",
    },
  });
  expect(setup.status()).toBe(201);
  await page.goto("/scan");
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, (await setup.json()).setup_qr);
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();
  await expect(page.getByTestId("pill")).toContainText("0 queued");
  // Let the QR decoder files and a first background pass (the staff list) land before the cut.
  await page.waitForTimeout(2500);

  const before = await admitted();
  const conflictsBefore = await conflicts();

  // The network dies completely: neither a hub nor the VM can be reached.
  await context.setOffline(true);
  await feed(page, ticket);
  const result = page.getByTestId("result");
  await expect(result).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result-title")).toHaveText("Offline Olga");
  await expect(page.getByTestId("result-banner")).toHaveText("OFFLINE");
  await expect(result).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "offline");
  await expect(page.getByTestId("pill")).toContainText("1 queued");
  await expect(page.getByTestId("offline-banner")).toBeVisible();

  // The same ticket again (after the 3 s debounce): decided from the phone's own list.
  await page.waitForTimeout(3200);
  await feed(page, ticket);
  await expect(page.getByTestId("result-title")).toHaveText("Already inside (offline)");
  await expect(page.getByTestId("result-banner")).toHaveText("OFFLINE");
  await page.getByTestId("result").click();
  await expect(page.getByTestId("pill")).toContainText("1 queued");

  // Reload with no network: the scanner still opens, still logged in, and the outbox is still 1.
  await page.reload();
  await page.waitForFunction(() => !!window.__scannerFeed);
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();
  await expect(page.getByTestId("pill")).toContainText("1 queued");
  expect(await admitted()).toBe(before); // the VM has heard nothing yet (it is a different, online context)

  // Offline staff login: sign out, then log in again with no network. A wrong PIN is refused.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill("not-the-pin");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert")).toContainText("Wrong name or PIN");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();

  // Still decides alone after the reload and the login: a second ticket, and the count is 2.
  await feed(page, other);
  await expect(page.getByTestId("result-banner")).toHaveText("OFFLINE");
  await expect(page.getByTestId("pill")).toContainText("2 queued");
  await page.getByTestId("result").waitFor({ state: "hidden", timeout: 5000 });

  // The network comes back: the outbox drains into the VM, exactly once each.
  await context.setOffline(false);
  await expect(page.getByTestId("pill")).toContainText("0 queued", { timeout: 20_000 });
  await expect.poll(admitted, { timeout: 10_000 }).toBe(before + 2);
  await page.waitForTimeout(2500);
  expect(await admitted()).toBe(before + 2);
  expect(await conflicts()).toBe(conflictsBefore);
  await expect(page.getByTestId("offline-banner")).toBeHidden();
  await expect(page.getByTestId("pill")).toHaveAttribute("data-link", "cloud");
});
