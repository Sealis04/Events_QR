import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { E2E_PIN } from "./constants";

/**
 * Reviewer screenshots (desktop 1280x800, phone 390x844) of every M11 screen. Only runs with
 * SHOTS=1: `SHOTS=1 bunx playwright test e2e/screenshots.spec.ts`. Output: plans/m11-ui-refresh/screenshots/after/.
 */
test.skip(!process.env.SHOTS, "set SHOTS=1 to take the reviewer screenshots");
const BASE = "http://127.0.0.1:3100";
const OUT = resolve(import.meta.dirname, "../../../plans/m11-ui-refresh/screenshots/after");
mkdirSync(OUT, { recursive: true });

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: BASE });
  expect((await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } })).ok()).toBe(true);
  return ctx;
}

const sizes = [
  { tag: "desktop", width: 1280, height: 800 },
  { tag: "phone", width: 390, height: 844 },
] as const;

for (const size of sizes) {
  test.describe(size.tag, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    const shot = (page: Page, name: string, full = true) =>
      page.screenshot({ path: `${OUT}/${name}-${size.tag}.png`, fullPage: full });

    test("dashboard screens", async ({ page }) => {
      test.setTimeout(120_000);
      const admin = await loggedIn("e2e-admin");
      const events = await (await admin.get("/api/events")).json();
      const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
      for (const [n, holder] of [
        [0, "Ada Lovelace"],
        [1, "Vera Vip"],
        [0, "Grace Hopper"],
      ] as const)
        await admin.post(`/api/events/${id}/tickets`, {
          data: {
            idempotency_key: `shot-${Date.now()}-${Math.random()}`,
            ticket_type: n,
            holder_name: holder,
          },
        });
      await page.goto("/login");
      await shot(page, "login");
      await page.getByPlaceholder("Name").fill("e2e-admin");
      await page.getByPlaceholder("PIN").fill(E2E_PIN);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.getByTestId("who")).toBeVisible();
      await page.waitForLoadState("networkidle");
      await shot(page, "events");
      await page.goto("/events/new");
      await page.waitForLoadState("networkidle");
      await shot(page, "new-event");
      for (const tab of [
        "generator",
        "tickets",
        "live",
        "devices",
        "conflicts",
        "admit",
        "setup",
      ]) {
        await page.goto(`/events/${id}?tab=${tab}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(400);
        await shot(page, `tab-${tab}`);
      }
      await page.goto(`/events/${id}?tab=tickets`);
      await page.waitForLoadState("networkidle");
      await page
        .getByRole("button", { name: /menu|actions|⋯/i })
        .first()
        .click();
      await shot(page, "tickets-row-menu", false);
      await page.goto(`/events/${id}?tab=devices`);
      await page.waitForLoadState("networkidle");
    });

    test("scanner screens", async ({ page }) => {
      test.setTimeout(120_000);
      const sup = await loggedIn("e2e-super");
      const events = await (await sup.get("/api/events")).json();
      const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
      const qr = (
        await (
          await sup.post("/api/devices/enroll", {
            data: { event_id: id, gate: "Gate A", direction: "both", label: "shot phone" },
          })
        ).json()
      ).setup_qr as string;
      const ticket = (
        await (
          await sup.post(`/api/events/${id}/tickets`, {
            data: {
              idempotency_key: `shot-${Date.now()}-${Math.random()}`,
              ticket_type: 0,
              holder_name: "Ada Lovelace",
            },
          })
        ).json()
      ).tickets[0].token as string;
      await new Promise((r) => setTimeout(r, 1100));
      const feed = (raw: string) => page.evaluate((c) => window.__scannerFeed!(c), raw);
      await page.goto("/scan");
      await page.waitForFunction(() => !!window.__scannerFeed);
      await shot(page, "scan-setup", false);
      await feed(qr);
      await expect(page.getByTestId("ready")).toBeVisible();
      await shot(page, "scan-login", false);
      await page.getByPlaceholder("Name").fill("e2e-staff");
      await page.getByPlaceholder("PIN").fill(E2E_PIN);
      await page.getByRole("button", { name: "Log in" }).click();
      await expect(page.locator("main[data-phase=scan]")).toBeVisible();
      await shot(page, "scan-ready", false);
      await page.getByRole("button", { name: "Menu" }).click();
      await shot(page, "scan-menu", false);
      await page.getByRole("button", { name: "Set up this phone again" }).click();
      await shot(page, "scan-menu-erase", false);
      await page.keyboard.press("Escape");
      await page.reload();
      await page.waitForFunction(() => !!window.__scannerFeed);
      await feed(ticket);
      await expect(page.getByTestId("result")).toBeVisible();
      await shot(page, "scan-green", false);
      await page.waitForTimeout(3500);
      await feed(ticket);
      await expect(page.getByTestId("result")).toHaveAttribute("data-tone", "red");
      await shot(page, "scan-red", false);
    });
  });
}
