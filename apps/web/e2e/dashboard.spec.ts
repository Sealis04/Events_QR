import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_PIN } from "./constants";

/**
 * The organiser's dashboard on the VM: an admin sets up an event in the browser, generates a
 * ticket and opens its print page, finds it in the list, a real phone scans it and the live stats
 * and device panel move, and a forced double admission shows up in the conflict feed. (The hub's
 * dashboard with the uplink cut is exercised in hub.spec.ts.)
 */
const BASE = "http://127.0.0.1:3100";

const feed = (page: Page, raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);

/** `datetime-local` text for a moment, as the wall clock in UTC (the form's zone is set to UTC below). */
const localInput = (d: Date) => d.toISOString().slice(0, 16);

async function login(page: Page, name: string) {
  await page.goto("/login");
  await page.getByPlaceholder("Name").fill(name);
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByTestId("who")).toContainText(name);
}

/** A phone enrolled through the API only (for the forced conflict). */
async function apiPhone(admin: APIRequestContext, eventId: number, gate: string) {
  const setup = await admin.post("/api/devices/enroll", {
    data: { event_id: eventId, gate, direction: "entry", label: `api ${gate}` },
  });
  expect(setup.status()).toBe(201);
  const { decodeSetupCode } = await import("../../../packages/core/src/setup");
  const decoded = decodeSetupCode((await setup.json()).setup_qr);
  if (!decoded.ok) throw new Error("bad setup qr");
  const id = randomUUID();
  const anon = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await anon.post("/api/devices/enroll", {
    data: { code: decoded.setup.code, device_id: id },
  });
  expect(res.ok()).toBe(true);
  return { id, token: (await res.json()).device_token as string };
}

test("admin creates an event, generates and prints a ticket, finds it, a phone scans it, stats and devices update, a conflict is reviewed", async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  await login(page, "e2e-admin");

  // --- Event setup in the UI: two gates (the defaults) and two ticket types.
  await page.getByRole("link", { name: "New event" }).click();
  await page.getByLabel("Event name").fill("Dash Fest");
  await page.getByLabel("Venue").fill("Test Hall");
  await page.getByLabel("Time zone").selectOption("UTC");
  await page.getByLabel("Doors open").fill(localInput(new Date(Date.now() - 3600_000)));
  await page.getByLabel("Ends").fill(localInput(new Date(Date.now() + 8 * 3600_000)));
  // The form starts with one type, "GA" (a summary card). The VIP preset opens its editor.
  await expect(page.getByTestId("type-card")).toHaveCount(1);
  await page.getByRole("button", { name: "VIP", exact: true }).click();
  await page.getByLabel("Places").fill("2");
  await page.getByRole("button", { name: "Up to a number" }).click();
  await page.getByLabel("Maximum entries").fill("3");
  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByTestId("type-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Create event" }).click();
  await expect(page).toHaveURL(/\/events\/\d+$/);
  const eventId = Number(page.url().split("/").pop());
  await expect(page.getByTestId("event-meta")).toContainText("Dash Fest");
  await expect(page.getByTestId("event-meta")).toContainText("Gate A, Gate B");

  // --- Generate a ticket; the QR shows at once.
  await page.getByLabel("Holder name").fill("Dash Tester");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("issued")).toBeVisible();
  await expect(page.getByTestId("issued").locator("img")).toBeVisible();
  const shortId = (await page.getByTestId("short-id").innerText()).trim();
  expect(shortId).toMatch(/^[0-9a-f]{6}$/i);

  // "Generate another" keeps the ticket type.
  await page.getByLabel("Ticket type", { exact: true }).selectOption({ label: "VIP (2 left)" });
  await page.getByRole("button", { name: "Generate another" }).click();
  await expect(page.getByTestId("issued")).toBeHidden();
  await expect(page.getByLabel("Ticket type", { exact: true })).toHaveValue("1");

  // Sold out: capacity 2.
  await page.getByLabel("Holder name").fill("VIP One");
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByText(/Sold out/)).toBeVisible();
  await page.getByLabel("Quantity").fill("1");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  await expect(page.getByTestId("issued")).toBeVisible();

  // --- Print page: the caption has name, event, type and the last 6 hex.
  await page.getByRole("button", { name: "Generate another" }).click();
  await page.getByLabel("Ticket type", { exact: true }).selectOption({ label: "GA" });
  await page.getByLabel("Holder name").fill("Print Pat");
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const printShort = (await page.getByTestId("short-id").innerText()).trim();
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "Print / PDF" }).click(),
  ]);
  await expect(popup.getByTestId("print-sheet")).toContainText("Print Pat");
  await expect(popup.getByTestId("print-sheet")).toContainText("Dash Fest");
  await expect(popup.getByTestId("print-sheet")).toContainText("GA");
  await expect(popup.getByTestId("print-sheet")).toContainText("Test Hall");
  await expect(popup.getByTestId("print-gates")).toContainText("Gate A, Gate B");
  await expect(popup.getByTestId("print-short-id")).toHaveText(printShort);
  await expect(popup.locator("img")).toBeVisible();
  await popup.close();

  // --- Ticket list: found by the last 6 hex, and by name; CSV import adds rows.
  await page.getByRole("link", { name: "Tickets" }).click();
  await page.getByLabel("Search tickets").fill(shortId.toLowerCase());
  await expect(page.getByTestId("ticket-table")).toContainText("Dash Tester");
  await expect(page.getByTestId("ticket-table").locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("Import CSV").setInputFiles({
    name: "guests.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      "holder_name,ticket_type,holder_email\nCsv Carl,GA,carl@example.org\nCsv Cora,GA,\n",
    ),
  });
  await expect(page.getByText("Imported 2 tickets.")).toBeVisible();
  await page.getByLabel("Search tickets").fill("carl@example");
  await expect(page.getByTestId("ticket-table")).toContainText("Csv Carl");

  // --- A real phone scans Dash Tester's ticket.
  const admin = page.request;
  const found = await (await admin.get(`/api/events/${eventId}/tickets?q=${shortId}`)).json();
  const ticketId = found.tickets.find(
    (t: { holder_name: string }) => t.holder_name === "Dash Tester",
  ).ticket_id;
  const token = (await (await admin.get(`/api/tickets/${ticketId}`)).json()).token as string;
  const setup = await admin.post("/api/devices/enroll", {
    data: { event_id: eventId, gate: "Gate A", direction: "entry", label: "dash phone" },
  });
  const phoneContext = await browser.newContext({ baseURL: BASE });
  const phone = await phoneContext.newPage();
  await phone.goto("/scan");
  await phone.waitForFunction(() => !!window.__scannerFeed);
  await feed(phone, (await setup.json()).setup_qr);
  await expect(phone.getByTestId("ready")).toHaveText("Gate A · Entry");
  await phone.getByPlaceholder("Name").fill("e2e-staff");
  await phone.getByPlaceholder("PIN").fill(E2E_PIN);
  await phone.getByRole("button", { name: "Log in" }).click();
  await expect(phone.locator("main[data-phase=scan]")).toBeVisible();

  await page.getByRole("link", { name: "Live stats" }).click();
  await expect(page.getByTestId("stat-total")).toHaveText("0");
  await feed(phone, token);
  await expect(phone.getByTestId("result")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("stat-total")).toHaveText("1", { timeout: 20_000 });
  await expect(page.getByTestId("stat-inside")).toHaveText("1");
  await expect(page.getByTestId("gate-Gate A")).toHaveText("1");
  await expect(page.getByTestId("gate-Gate B")).toHaveText("0");
  await expect(page.getByTestId("type-0")).toContainText("1");

  await page.getByRole("link", { name: "Devices" }).click();
  const row = page.getByTestId("device-dash phone");
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-state", "Online");
  await expect(row).toContainText("Gate A");
  await expect(row).not.toHaveClass(/hot/);
  // The phone reports its outbox in its next background pass.
  await expect(row.locator("td").nth(5)).toHaveText("0", { timeout: 30_000 });

  // --- A forced double admission: two phones upload offline admits of one ticket.
  const t2 = await (await admin.get(`/api/events/${eventId}/tickets?q=Csv Cora`)).json();
  const cora = t2.tickets[0].ticket_id as string;
  const a = await apiPhone(admin, eventId, "Gate A");
  const b = await apiPhone(admin, eventId, "Gate B");
  const now = Math.floor(Date.now() / 1000);
  const rec = (dev: { id: string }, gate: string, at: number) => ({
    scan_id: randomUUID(),
    ticket_id: cora,
    device_id: dev.id,
    staff_id: null,
    gate,
    direction: "entry",
    scanned_at: at,
    result: "admitted",
    offline: true,
  });
  for (const [dev, gate, at] of [
    [a, "Gate A", now - 30],
    [b, "Gate B", now - 5],
  ] as const) {
    const up = await (
      await playwrightRequest.newContext({ baseURL: BASE })
    ).post("/api/scans", {
      headers: { authorization: `Bearer ${dev.token}` },
      data: { scans: [rec(dev, gate, at)] },
    });
    expect(up.ok()).toBe(true);
  }
  await page.getByRole("link", { name: "Conflicts" }).click();
  const conflict = page.getByTestId("conflict");
  await expect(conflict).toHaveCount(1);
  await expect(conflict).toContainText("Csv Cora");
  await expect(conflict).toContainText("Stays valid (first)");
  await expect(conflict).toContainText("Flagged (later)");
  await expect(conflict).toContainText("Gate A");
  await expect(conflict).toContainText("Gate B");
  await conflict.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(page.getByTestId("conflict")).toHaveCount(0);
  await page.getByLabel("Show reviewed").check();
  await expect(page.getByTestId("conflict")).toContainText("reviewed");

  // --- Manual admit on the VM: wrong PIN refused, right PIN logged as an override.
  await page.getByRole("link", { name: "Attendees & overrides" }).click();
  await page.getByLabel("Find an attendee").fill("Print Pat");
  await page.getByTestId("attendees").getByRole("button", { name: "Admit" }).click();
  await page.getByLabel("Supervisor PIN").fill("00000000");
  await page.getByRole("button", { name: "Confirm admit" }).click();
  await expect(page.getByText("wrong PIN")).toBeVisible();
  await page.getByLabel("Supervisor PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Confirm admit" }).click();
  await expect(page.getByText(/Admitted \(logged as an override\)/)).toBeVisible();
  await expect(page.getByTestId("overrides")).toContainText("Print Pat");
  await expect(page.getByTestId("overrides")).toContainText("e2e-admin");

  // --- Setup saves every change at once.
  await page.getByRole("link", { name: "Setup" }).click();
  await page.getByLabel("Venue").fill("Test Hall 2");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\./)).toBeVisible();
  await expect(page.getByTestId("event-meta")).toContainText("Test Hall 2");

  await phoneContext.close();
});
