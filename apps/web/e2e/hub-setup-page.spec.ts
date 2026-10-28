import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { E2E_PIN } from "./constants";
import { expectNoScrollbars } from "./noScrollbars";

/**
 * M14, hub mode: a fresh hub goes unlinked -> any page lands on /setup -> setup code -> login ->
 * Reset hub -> back on /setup, using only the browser. Runs before the specs that link the hub
 * with the script (file order: "hub-setup-page" sorts before "hub-setup.spec" and "hub.spec"), and
 * leaves the hub unlinked again. Reviewer screenshots with SHOTS=1.
 */
const VM = "http://127.0.0.1:3100";
const HUB = "http://127.0.0.1:3200";
const OUT = resolve(import.meta.dirname, "../../../plans/m14-hub-setup-page/screenshots");
if (process.env.SHOTS) mkdirSync(OUT, { recursive: true });

async function loggedIn(name: string): Promise<APIRequestContext> {
  const ctx = await playwrightRequest.newContext({ baseURL: VM });
  const res = await ctx.post("/api/auth/login", { data: { name, pin: E2E_PIN } });
  expect(res.ok()).toBe(true);
  return ctx;
}

async function newCode(): Promise<string> {
  const supervisor = await loggedIn("e2e-super");
  const events = await (await supervisor.get("/api/events")).json();
  const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
  const res = await supervisor.post("/api/hubs/setup", {
    data: { event_id: id, label: "setup page" },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).setup_code as string;
}

const sizes = [
  { tag: "desktop", width: 1280, height: 800 },
  { tag: "phone", width: 390, height: 844 },
  { tag: "small", width: 360, height: 740 },
] as const;
/** Phones have no scrollbars (M11): checked on the setup page and the reset dialog. */
const phone = (tag: string) => tag !== "desktop";

test.describe.configure({ mode: "serial" });

for (const size of sizes) {
  test(`unlinked hub -> /setup -> code -> login -> Reset hub -> /setup (${size.tag})`, async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport: size });
    const page = await context.newPage();
    const shot = async (name: string) => {
      if (process.env.SHOTS)
        await page.screenshot({ path: `${OUT}/${name}-${size.tag}.png`, fullPage: true });
    };

    // Any page of an unlinked hub lands on /setup; the VM has no such page.
    for (const path of ["/", "/login", "/events/1"]) {
      await page.goto(`${HUB}${path}`);
      await expect(page).toHaveURL(`${HUB}/setup`);
    }
    expect((await context.request.get(`${VM}/setup`)).status()).toBe(404);
    expect((await (await context.request.get(`${HUB}/api/hub/status`)).json()).linked).toBe(false);
    await expect(page.getByTestId("setup-server")).toHaveValue(VM);
    await shot("setup-empty");
    if (phone(size.tag)) await expectNoScrollbars(page, "setup page", true);

    // A wrong code says why, in words.
    // (The hub allows 5 tries a minute per client, so the smallest size skips this one.)
    if (size.tag !== "small") {
      await page.getByPlaceholder("Setup code").fill("not-a-real-code");
      await page.getByRole("button", { name: "Link hub" }).click();
      await expect(page.getByTestId("setup-error")).toContainText("not accepted");
      await shot("setup-error");
      if (phone(size.tag)) await expectNoScrollbars(page, "setup page with an error", true);
    }

    // A real one links and says to what.
    await page.getByPlaceholder("Setup code").fill(await newCode());
    await page.getByRole("button", { name: "Link hub" }).click();
    await expect(page.getByTestId("setup-done")).toContainText("Linked to E2E Fest");
    await shot("setup-linked");
    if (phone(size.tag)) await expectNoScrollbars(page, "setup page linked", true);
    // Once linked, the page and the link route are gone.
    expect(
      (await context.request.post(`${HUB}/api/hub/link`, { data: { code: "x" } })).status(),
    ).toBe(409);
    await page.getByRole("link", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${HUB}/login`);
    await page.goto(`${HUB}/setup`);
    await expect(page).toHaveURL(`${HUB}/login`);

    await page.getByPlaceholder("Name").fill("e2e-super");
    await page.getByPlaceholder("PIN").fill(E2E_PIN);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByTestId("who")).toContainText("e2e-super");
    await expect(page.getByTestId("reset-hub")).toBeVisible();

    // Reset: the dialog says what goes, then the hub is back on /setup with nothing left.
    await page.getByRole("button", { name: "Reset hub" }).click();
    await expect(page.getByRole("dialog")).toContainText("deletes");
    await expect(page.getByTestId("reset-unsent")).toBeVisible();
    await shot("reset-dialog");
    if (phone(size.tag)) await expectNoScrollbars(page, "reset dialog");
    await page.getByTestId("reset-confirm").click();
    await expect(page).toHaveURL(`${HUB}/setup`);
    expect((await (await context.request.get(`${HUB}/api/hub/status`)).json()).linked).toBe(false);
    // The old session is gone with the keys.
    expect((await context.request.get(`${HUB}/api/events`)).status()).toBe(401);
    // The server was told: the hub's own row there is revoked.
    const admin = await loggedIn("e2e-admin");
    const events = await (await admin.get("/api/events")).json();
    const id = events.find((e: { name: string }) => e.name === "E2E Fest").id as number;
    const panel = await (await admin.get(`/api/events/${id}/devices`)).json();
    const hubs = panel.devices.filter((d: { kind: string }) => d.kind === "hub");
    expect(hubs.length).toBeGreaterThan(0);
    expect(hubs.every((d: { revoked: boolean }) => d.revoked)).toBe(true);
    await context.close();
  });
}
