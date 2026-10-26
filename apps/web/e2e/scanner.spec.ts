import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_PIN } from "./constants";

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

async function setupQr(direction: "entry" | "exit" | "both" = "entry", gate = "Gate A") {
  const supervisor = await loggedIn("e2e-super");
  const res = await supervisor.post("/api/devices/enroll", {
    data: { event_id: await eventId(supervisor), gate, direction, label: "e2e phone" },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).setup_qr as string;
}

/** `settle`: wait out the sync horizon (SYNC_HORIZON_SECONDS = 1) so the next phone sync includes it. */
async function newTicket(ticketType = 0, holder = "Ada Lovelace", settle = true) {
  const staff = await loggedIn("e2e-staff");
  const res = await staff.post(`/api/events/${await eventId(staff)}/tickets`, {
    data: {
      idempotency_key: `e2e-${Date.now()}-${Math.random()}`,
      ticket_type: ticketType,
      holder_name: holder,
    },
  });
  expect(res.status()).toBe(201);
  if (settle) await new Promise((resolve) => setTimeout(resolve, 1100));
  return (await res.json()).tickets[0].token as string;
}

/** Feeds a code through the same path the camera uses. */
const feed = (page: Page, raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);

async function enrolAndLogin(page: Page, qr: string) {
  await page.goto("/scan");
  await expect(page.getByRole("button", { name: "Set up for event" })).toBeVisible();
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, qr);
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();
}

test("enrol with a setup QR, scan a ticket green, rescan red 'already used'", async ({ page }) => {
  const ticket = await newTicket(0, "Ada Lovelace");
  await enrolAndLogin(page, await setupQr());
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await expect(page.getByTestId("pill")).toContainText("VM only");

  await feed(page, ticket);
  const result = page.getByTestId("result");
  await expect(result).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result-title")).toHaveText("ADMITTED");
  await expect(page.getByTestId("result-holder")).toHaveText("Ada Lovelace");
  await expect(result).toBeHidden({ timeout: 5000 }); // auto-dismiss after 1.5 s

  // The same code within 3 s is debounced: no false "already used".
  await feed(page, ticket);
  await page.waitForTimeout(500);
  await expect(result).toBeHidden();

  await page.waitForTimeout(3000);
  await feed(page, ticket);
  await expect(result).toHaveAttribute("data-tone", "red");
  await expect(page.getByTestId("result-title")).toHaveText("ALREADY USED");
  await expect(result).toContainText("Gate A");
  await expect(result).toContainText("Do not let them in");
  await expect(result).not.toContainText(/[0-9a-f]{8}-[0-9a-f]{4}-/); // never a raw device id
  await page.getByRole("button", { name: "Next scan" }).click(); // red screens wait for the button
  await expect(result).toBeHidden();

  await feed(page, "https://example.org/not-a-ticket");
  await expect(page.getByTestId("result-title")).toHaveText("NOT A TICKET");
});

test("a ticket unknown to the phone shows amber; a supervisor override admits it", async ({
  page,
}) => {
  await enrolAndLogin(page, await setupQr());
  const fresh = await newTicket(0, "Late Issue", false); // issued after the phone's sync
  await feed(page, fresh);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "amber");
  await page.getByRole("button", { name: "Supervisor override" }).click();
  await page.getByPlaceholder("Supervisor name").fill("e2e-super");
  await page.getByPlaceholder("Supervisor PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Admit" }).click();
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
});

test("the scanner loads with the network off after the first visit", async ({ page, context }) => {
  const ticket = await newTicket(0, "Offline Olive");
  await enrolAndLogin(page, await setupQr());

  // The service worker must be in control and hold the shell and the decoder WASM.
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const assets = await caches.open("scan-assets-v1");
    return (await assets.keys()).some((r) => r.url.endsWith(".wasm"));
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry");
  await expect(page.locator("main[data-phase=scan]")).toBeVisible();

  // M5: with no server the phone decides alone from its own ticket list (orange OFFLINE banner).
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, ticket);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result-banner")).toHaveText("OFFLINE");
  await expect(page.getByTestId("pill")).toContainText("Offline");

  await context.setOffline(false);
  // Let the queued scan reach the server before the next test counts admits.
  await expect(page.getByTestId("waiting")).toContainText("0 waiting", { timeout: 20_000 });
});

test("a device set to 'both' shows the Entry / Exit toggle and records exits", async ({ page }) => {
  const ticket = await newTicket(1, "Vera VIP");
  await page.goto("/scan");
  await page.waitForFunction(() => !!window.__scannerFeed);
  await feed(page, await setupQr("both"));
  await expect(page.getByTestId("ready")).toHaveText("Gate A · Entry / Exit");
  await page.getByPlaceholder("Name").fill("e2e-staff");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await page.getByRole("button", { name: "Entry", exact: true }).waitFor();

  await feed(page, ticket);
  await expect(page.getByTestId("result-title")).toHaveText("ADMITTED");
  await expect(page.getByTestId("result-holder")).toHaveText("Vera VIP");
  await expect(page.getByTestId("result")).toContainText("Entry 1 of 3");
  await expect(page.getByTestId("result")).toBeHidden({ timeout: 5000 });

  await page.getByRole("button", { name: "Exit", exact: true }).click();
  await page.waitForTimeout(3200);
  await feed(page, ticket);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result")).toContainText("Exit");
  await expect(page.getByTestId("result")).toContainText("Entries left: 2");
});

/** ⋯ menu, "Set up this phone again", then the red box's "Erase and set up". */
async function openSetUpAgain(page: Page) {
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Set up this phone again" }).click();
  await expect(page.getByTestId("erase-box")).toContainText("erases the event, tickets and logins");
  await page.getByRole("button", { name: "Erase and set up" }).click();
}

/** Every record in every object store of the scanner's IndexedDB. */
const idbRecordCounts = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const open = indexedDB.open("events-qr-scanner");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = Array.from(db.objectStoreNames);
          const counts: Record<string, number> = {};
          const tx = db.transaction(names);
          for (const name of names) {
            const req = tx.objectStore(name).count();
            req.onsuccess = () => (counts[name] = req.result);
          }
          tx.oncomplete = () => {
            db.close();
            resolve(counts);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
  );

test("'Set up again' with scans still queued asks a supervisor, then leaves no ticket or key on the phone", async ({
  page,
  context,
}) => {
  const ticket = await newTicket(0, "Queued Quinn");
  await enrolAndLogin(page, await setupQr());
  await page.waitForFunction(() => !!window.__scannerFeed);
  const before = await idbRecordCounts(page);
  expect(before.device).toBe(1);
  expect(before.tickets).toBeGreaterThan(0);

  // With no network the admit stays in the outbox, so wiping would lose it.
  await context.setOffline(true);
  await feed(page, ticket);
  await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("result")).toBeHidden({ timeout: 5000 });
  await expect(page.getByTestId("waiting")).toContainText("1 waiting");

  await openSetUpAgain(page);
  const confirm = page.getByTestId("wipe-confirm");
  await expect(confirm).toContainText("1 scan not uploaded");
  expect((await idbRecordCounts(page)).outbox).toBe(1); // nothing wiped yet

  // A staff member's PIN is not enough.
  await page.getByPlaceholder("Supervisor name").fill("e2e-staff");
  await page.getByPlaceholder("Supervisor PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Discard scans and set up again" }).click();
  await expect(confirm.getByRole("alert")).toContainText("not a supervisor");
  expect((await idbRecordCounts(page)).outbox).toBe(1);

  await page.getByPlaceholder("Supervisor name").fill("e2e-super");
  await page.getByRole("button", { name: "Discard scans and set up again" }).click();
  await expect(page.locator("main[data-phase=setup]")).toBeVisible();
  expect(await idbRecordCounts(page)).toEqual({
    device: 0,
    keys: 0,
    tickets: 0,
    outbox: 0,
    meta: 0,
  });
  await context.setOffline(false);
});

test("'Set up again' with nothing queued wipes at once", async ({ page }) => {
  await enrolAndLogin(page, await setupQr());
  await openSetUpAgain(page);
  await expect(page.locator("main[data-phase=setup]")).toBeVisible();
  const counts = await idbRecordCounts(page);
  expect(Object.values(counts).every((n) => n === 0)).toBe(true);
});
