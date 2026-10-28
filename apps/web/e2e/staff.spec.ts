import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_PIN } from "./constants";

/** M13: the Staff page, end to end through the browser. */
async function login(page: Page, name: string, pin = E2E_PIN) {
  await page.goto("/login");
  await page.getByPlaceholder("Name").fill(name);
  await page.getByPlaceholder("PIN").fill(pin);
  await page.getByRole("button", { name: "Log in" }).click();
  // Wait for the session: either the dashboard or, after a reset, the PIN-change screen.
  await expect(
    page.getByTestId("who").or(page.getByText("That name and PIN do not match")),
  ).toBeVisible();
}

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="staff-row"][data-name="${name}"]`);
async function pick(page: Page, name: string, item: string) {
  await row(page, name)
    .getByRole("button", { name: `Actions for ${name}` })
    .click();
  await page.getByRole("menuitem", { name: item }).click();
}

test("one admin: the banner offers a way to add a second", async ({ page }) => {
  await login(page, "e2e-admin");
  await expect(page.getByTestId("who")).toContainText("e2e-admin");
  await page.getByRole("link", { name: "Staff" }).click();
  await expect(page).toHaveURL(/\/staff$/);
  await expect(page.getByTestId("one-admin")).toContainText("Only one admin");
  await expect(page.getByTestId("one-admin")).toContainText("setup guide 1.7");
  await page.getByTestId("one-admin").getByRole("button", { name: "Add an admin" }).click();
  await expect(page.getByRole("dialog")).toContainText("Create account");
  await page.getByRole("button", { name: "Cancel" }).click();
  // The admin cannot deactivate or demote themselves.
  await row(page, "e2e-admin")
    .getByRole("button", { name: /Actions for/ })
    .click();
  await expect(page.getByRole("menuitem", { name: "Deactivate" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Change role" })).toBeDisabled();
});

test("create, reset PIN, forced change, deactivate, refused session, reactivate", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await login(page, "e2e-admin");
  await page.goto("/staff");

  // Create: the PIN works at once, with no forced change.
  await page.getByRole("button", { name: "Create account" }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Flow Person");
  await page.getByLabel("PIN", { exact: true }).fill("flowpin1");
  await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
  await expect(row(page, "Flow Person")).toContainText("Active");
  await expect(page.getByTestId("staff-log")).toContainText("created Flow Person as staff");

  const person = await browser.newContext();
  const personPage = await person.newPage();
  await login(personPage, "Flow Person", "flowpin1");
  await expect(personPage.getByTestId("who")).toContainText("Flow Person");
  await expect(personPage.getByText("Choose a new PIN")).toBeHidden();

  // Reset PIN: they must choose a new one before anything else.
  await pick(page, "Flow Person", "Reset PIN");
  await expect(page.getByRole("dialog")).toContainText("must choose a new PIN");
  await page.getByLabel("Temporary PIN").fill("temp-pin-1");
  await page.getByRole("dialog").getByRole("button", { name: "Reset PIN" }).click();
  await expect(row(page, "Flow Person")).toContainText("Must change PIN");
  await personPage.reload();
  await expect(personPage.getByRole("heading", { name: "Choose a new PIN" })).toBeVisible();
  await person.close();

  const again = await browser.newContext();
  const againPage = await again.newPage();
  await login(againPage, "Flow Person", "temp-pin-1");
  await expect(againPage.getByRole("heading", { name: "Choose a new PIN" })).toBeVisible();
  await againPage.getByLabel("Current PIN").fill("temp-pin-1");
  await againPage.getByLabel("New PIN", { exact: true }).fill("my-own-pin");
  await againPage.getByLabel("New PIN again").fill("my-own-pin");
  await againPage.getByRole("button", { name: "Change PIN" }).click();
  await expect(againPage.getByRole("heading", { name: "Choose a new PIN" })).toBeHidden();
  await page.reload();
  await expect(row(page, "Flow Person")).toContainText("Active");

  // Deactivate: the live session is refused on its next request.
  await pick(page, "Flow Person", "Deactivate");
  await expect(page.getByRole("dialog")).toContainText("within about 10 seconds");
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(row(page, "Flow Person")).toContainText("Deactivated");
  const last = page.locator('[data-testid="staff-row"]').last();
  await expect(last).toHaveAttribute("data-name", "Flow Person");
  expect((await againPage.request.get("/api/auth/me")).status()).toBe(401);
  await login(againPage, "Flow Person", "my-own-pin");
  await expect(againPage).toHaveURL(/\/login/);
  await expect(againPage.getByText("That name and PIN do not match")).toBeVisible();

  // Filter, then reactivate.
  await page.getByRole("button", { name: "Active", exact: true }).click();
  await expect(row(page, "Flow Person")).toHaveCount(0);
  await page.getByRole("button", { name: "Deactivated", exact: true }).click();
  await pick(page, "Flow Person", "Reactivate");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(row(page, "Flow Person")).toContainText("Active");
  await login(againPage, "Flow Person", "my-own-pin");
  await expect(againPage.getByTestId("who")).toContainText("Flow Person");
  await expect(page.getByTestId("staff-log")).toContainText("reactivated Flow Person");
  await expect(page.getByTestId("staff-log")).toContainText("e2e-admin");
  await again.close();
});

test("the event Setup tab only assigns; accounts are managed on the Staff page", async ({
  page,
}) => {
  await login(page, "e2e-admin");
  const events = await (await page.request.get("/api/events")).json();
  const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
  await page.goto(`/events/${id}?tab=setup`);
  await expect(page.getByTestId("event-staff")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create and add" })).toHaveCount(0);
  await page.getByRole("link", { name: "Manage accounts" }).click();
  await expect(page).toHaveURL(/\/staff$/);
});

test("the ticket-type form says what each field does", async ({ page }) => {
  await login(page, "e2e-admin");
  await page.goto("/events/new");
  await page.getByRole("button", { name: "VIP", exact: true }).click();
  await expect(page.getByLabel("Tickets available")).toBeVisible();
  await expect(page.getByTestId("type-summary")).toHaveText("No limit · one entry");
  await expect(page.getByLabel("Early entry minutes")).toHaveCount(0);
  await page.getByLabel("Tickets available").fill("2");
  await page.getByRole("button", { name: "Up to a number" }).click();
  await expect(page.getByText("Entries per ticket (2–63)")).toBeVisible();
  await page.getByLabel("Maximum entries").fill("3");
  await expect(page.getByTestId("type-summary")).toHaveText("2 tickets · up to 3 entries each");
  await page.getByRole("button", { name: "+ Add another time" }).click();
  await expect(page.getByLabel("Early entry minutes")).toBeVisible();
  await expect(page.getByText("minutes before their time starts")).toBeVisible();
  await page.getByRole("button", { name: "Remove time slot 1" }).click();
  await expect(page.getByLabel("Early entry minutes")).toHaveCount(0);
});

/** Reviewer screenshots: `SHOTS=1 bunx playwright test e2e/staff.spec.ts -g screenshots`. */
const OUT = resolve(import.meta.dirname, "../../../plans/m13-staff-accounts/screenshots");
for (const size of [
  { tag: "desktop", width: 1280, height: 800 },
  { tag: "phone", width: 390, height: 844 },
]) {
  test(`screenshots ${size.tag}`, async ({ browser }) => {
    test.skip(!process.env.SHOTS, "set SHOTS=1 to take the reviewer screenshots");
    mkdirSync(OUT, { recursive: true });
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    await login(page, "e2e-admin");
    await page.goto("/staff");
    await expect(page.getByTestId("staff-table")).toBeVisible();
    await page.screenshot({ path: `${OUT}/staff-${size.tag}.png`, fullPage: true });
    await page.goto("/events/new");
    await page.getByRole("button", { name: "VIP", exact: true }).click();
    await page.getByLabel("Tickets available").fill("2");
    await page.getByRole("button", { name: "Up to a number" }).click();
    await page.getByLabel("Maximum entries").fill("3");
    await page.getByRole("button", { name: "+ Add another time" }).click();
    await page.screenshot({ path: `${OUT}/ticket-type-form-${size.tag}.png`, fullPage: true });
    await context.close();
  });
}
