import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_PIN } from "./constants";

/**
 * M11 (user decision): phones have no scrollbars. At 390x844 and 360x740 nothing overflows
 * sideways on any dashboard page or scanner state, and no element shows a scrollbar (elements
 * that must scroll hide theirs). Scanner screens must also fit the viewport height.
 */
const BASE = "http://127.0.0.1:3100";
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

/** Fails (with the offending elements named) on sideways overflow or a visible scrollbar. */
async function expectNoScrollbars(page: Page, label: string, fitsHeight = false) {
  await page.waitForTimeout(150);
  const problems = await page.evaluate((fits) => {
    const out: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth)
      out.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    if (fits && root.scrollHeight > root.clientHeight)
      out.push(`page scrolls vertically (${root.scrollHeight} > ${root.clientHeight})`);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || el === root || el === document.body) continue;
      const bx = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      const by = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const name = `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ").join(".") : ""}`;
      if (el.offsetWidth - el.clientWidth - bx > 0.5 && el.clientWidth > 0)
        out.push(`${name} shows a vertical scrollbar`);
      if (el.offsetHeight - el.clientHeight - by > 0.5 && el.clientHeight > 0)
        out.push(`${name} shows a horizontal scrollbar`);
    }
    return out;
  }, fitsHeight);
  expect(problems, label).toEqual([]);
}

for (const size of SIZES) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    test("every dashboard page", async ({ page }) => {
      test.setTimeout(120_000);
      await page.goto("/login");
      await expectNoScrollbars(page, "login");
      await page.getByPlaceholder("Name").fill("e2e-admin");
      await page.getByPlaceholder("PIN").fill(E2E_PIN);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.getByTestId("who")).toContainText("e2e-admin");
      await expectNoScrollbars(page, "events list");

      await page.goto("/events/new");
      await expect(page.getByLabel("Event name")).toBeVisible();
      await expectNoScrollbars(page, "new event");

      await page.goto("/staff");
      await expect(page.getByTestId("staff-table")).toBeVisible();
      await expectNoScrollbars(page, "staff page");
      await page.getByRole("button", { name: "Create account" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoScrollbars(page, "staff create dialog");
      await page.getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: /^Actions for e2e-super/ }).click();
      await expectNoScrollbars(page, "staff row menu");
      await page.keyboard.press("Escape");

      const admin = await loggedIn("e2e-admin");
      const events = await (await admin.get("/api/events")).json();
      const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
      for (const tab of [
        "generator",
        "tickets",
        "live",
        "devices",
        "conflicts",
        "admit",
        "hub-setup",
        "setup",
      ]) {
        await page.goto(`/events/${id}?tab=${tab}`);
        await expect(page.locator("h1")).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoScrollbars(page, `event tab ${tab}`);
      }

      // The hub setup page with its longest content: a setup code in a command, and a failed check
      // with its fix text (M12).
      await page.goto(`/events/${id}?tab=hub-setup`);
      await expect(page.getByTestId("hub-setup")).toBeVisible();
      await page.getByRole("button", { name: "Make a setup code" }).click();
      await expect(page.locator(".cmd code").first()).toBeVisible();
      await page.getByLabel(/Hub address/).fill("https://hub.cf.test");
      await page
        .getByTestId("step-dns_record")
        .getByRole("button", { name: /^Check:/ })
        .click();
      await expect(page.getByTestId("step-dns_record")).toHaveAttribute("data-result", "fail");
      await page.getByText(/Record of checks/).click();
      await expectNoScrollbars(page, "hub setup with a failed check and a setup code");

      const issued = await admin.post(`/api/events/${id}/tickets`, {
        data: {
          idempotency_key: `ns-${Date.now()}-${Math.random()}`,
          ticket_type: 0,
          holder_name: "Scroll Check",
        },
      });
      expect(issued.status()).toBe(201);
      const ticketId = (await issued.json()).tickets[0].ticket_id as string;
      await page.goto(`/events/${id}/print?ids=${ticketId}`);
      await page.waitForLoadState("networkidle");
      await expectNoScrollbars(page, "print page");
    });

    test("hub setup on the hub's own dashboard", async ({ browser }) => {
      test.setTimeout(60_000);
      const hubUrl = "http://127.0.0.1:3200";
      const events = await (await (await loggedIn("e2e-admin")).get("/api/events")).json();
      const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
      const context = await browser.newContext({ viewport: size });
      const page = await context.newPage();
      await page.goto(`${hubUrl}/login`);
      await page.getByPlaceholder("Name").fill("e2e-admin");
      await page.getByPlaceholder("PIN").fill(E2E_PIN);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.getByTestId("who")).toContainText("e2e-admin");
      await page.goto(`${hubUrl}/events/${id}?tab=hub-setup`);
      await expect(page.getByTestId("hub-setup")).toBeVisible();
      await page
        .getByTestId("step-offline_scan")
        .getByRole("button", { name: /^Check:/ })
        .click();
      await expect(page.getByTestId("step-offline_scan")).not.toHaveAttribute(
        "data-result",
        "none",
      );
      await expectNoScrollbars(page, "hub setup on the hub");
      await context.close();
    });

    test("every scanner state", async ({ page }) => {
      test.setTimeout(120_000);
      const supervisor = await loggedIn("e2e-super");
      const events = await (await supervisor.get("/api/events")).json();
      const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
      const enroll = await supervisor.post("/api/devices/enroll", {
        data: { event_id: id, gate: "Gate A", direction: "both", label: "scroll phone" },
      });
      expect(enroll.status()).toBe(201);
      const qr = (await enroll.json()).setup_qr as string;
      const staff = await loggedIn("e2e-staff");
      const ticketRes = await staff.post(`/api/events/${id}/tickets`, {
        data: {
          idempotency_key: `ns-${Date.now()}-${Math.random()}`,
          ticket_type: 0,
          holder_name: "Ada Lovelace",
        },
      });
      const ticket = (await ticketRes.json()).tickets[0].token as string;
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const feed = (raw: string) => page.evaluate((code) => window.__scannerFeed!(code), raw);
      await page.goto("/scan");
      await expect(page.getByRole("button", { name: "Set up for event" })).toBeVisible();
      await expectNoScrollbars(page, "scanner setup", true);
      await page.waitForFunction(() => !!window.__scannerFeed);
      await feed(qr);
      await expect(page.getByTestId("ready")).toContainText("Gate A");
      await expectNoScrollbars(page, "scanner login", true);
      await page.getByPlaceholder("Name").fill("e2e-staff");
      await page.getByPlaceholder("PIN").fill(E2E_PIN);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.locator("main[data-phase=scan]")).toBeVisible();
      await expectNoScrollbars(page, "scanner ready", true);

      await page.getByRole("button", { name: "Menu" }).click();
      await expect(page.getByTestId("menu")).toBeVisible();
      await expectNoScrollbars(page, "scanner menu", true);
      await page.getByRole("button", { name: "Camera help" }).click();
      await expectNoScrollbars(page, "scanner camera help", true);
      await page.keyboard.press("Escape");
      if (await page.getByTestId("menu").isHidden())
        await page.getByRole("button", { name: "Menu" }).click();
      await page.getByRole("button", { name: "Set up this phone again" }).click();
      await expect(page.getByTestId("erase-box")).toBeVisible();
      await expectNoScrollbars(page, "scanner erase box", true);
      await page.keyboard.press("Escape");
      await page.reload();
      await page.waitForFunction(() => !!window.__scannerFeed);
      await expect(page.locator("main[data-phase=scan]")).toBeVisible();

      await page.getByRole("button", { name: "Find a ticket by name" }).click();
      await expect(page.getByTestId("search")).toBeVisible();
      await expectNoScrollbars(page, "scanner search", true);
      await page.keyboard.press("Escape");
      if (await page.getByTestId("search").isVisible())
        await page
          .getByRole("button", { name: /close|back|cancel/i })
          .first()
          .click();

      await feed(ticket);
      await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "green");
      await expectNoScrollbars(page, "scanner admitted", true);
      await expect(page.getByTestId("result")).toBeHidden({ timeout: 8000 });
      await page.waitForTimeout(3200);
      await feed(ticket);
      await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "red");
      await expectNoScrollbars(page, "scanner refused", true);
      await page.getByRole("button", { name: "Next scan" }).click();
      await feed("https://example.org/not-a-ticket");
      await expect(page.getByTestId("result-title")).toHaveText("NOT A TICKET");
      await expectNoScrollbars(page, "scanner not a ticket", true);
    });
  });
}
