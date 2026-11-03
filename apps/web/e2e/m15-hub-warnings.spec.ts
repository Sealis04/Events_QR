import { randomUUID } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { E2E_PIN } from "./constants";
import { expectNoScrollbars } from "./noScrollbars";

/**
 * M15: the two traps that only show on phones and over http. The e2e VM has no HUB_URL, so once
 * the event has a linked hub the Devices and Hub setup tabs must warn (and stop warning when the
 * hub is revoked). Login over a name that is not localhost, on plain http, with the session
 * dropped, must say to use https (`*.localhost` resolves to this machine in Chromium).
 */
const VM = "http://127.0.0.1:3100";
const SIZES = [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
];

let supervisor: APIRequestContext;
let eventId: number;
let hubDeviceId: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  supervisor = await playwrightRequest.newContext({ baseURL: VM });
  const res = await supervisor.post("/api/auth/login", {
    data: { name: "e2e-super", pin: E2E_PIN },
  });
  expect(res.ok()).toBe(true);
  eventId = (await (await supervisor.get("/api/events")).json()).find(
    (e: { name: string }) => e.name === "E2E Fest",
  ).id;
  // Link a hub to the event on the VM the way a real hub does (code, then exchange).
  const setup = await supervisor.post("/api/hubs/setup", {
    data: { event_id: eventId, label: "m15 hub" },
  });
  expect(setup.status()).toBe(201);
  hubDeviceId = randomUUID();
  const enrol = await supervisor.post("/api/hubs/enroll", {
    data: { code: (await setup.json()).setup_code, device_id: hubDeviceId },
  });
  expect(enrol.ok()).toBe(true);
});

test.afterAll(async () => {
  await supervisor.post(`/api/devices/${hubDeviceId}/revoke`, { data: {} });
  await supervisor.dispose();
});

const text = "Phones set up from this page will not find the hub: HUB_URL is unset.";

for (const size of SIZES) {
  test(`the Devices and Hub setup tabs warn about HUB_URL (${size.width}x${size.height})`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(size);
    await page.goto("/login");
    await page.getByPlaceholder("Name").fill("e2e-admin");
    await page.getByPlaceholder("PIN").fill(E2E_PIN);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByTestId("who")).toContainText("e2e-admin");

    await page.goto(`/events/${eventId}?tab=devices`);
    const devices = page.getByTestId("hub-url-warning");
    await expect(devices).toContainText(text);
    await expect(devices).toContainText("Set HUB_URL=https://<hub name> in the server's .env");
    await page.waitForLoadState("networkidle");
    await expectNoScrollbars(page, "devices tab with the HUB_URL warning");

    await page.goto(`/events/${eventId}?tab=hub-setup`);
    await expect(page.getByTestId("hub-url-warning")).toContainText(text);
    await expect(page.getByTestId("step-phone_via_hub").getByRole("alert")).toContainText(
      "HUB_URL is unset",
    );
    await page.waitForLoadState("networkidle");
    await expectNoScrollbars(page, "hub setup tab with the HUB_URL warning");
  });
}

test("the warning goes away once no hub of the event is linked", async () => {
  const other = await playwrightRequest.newContext({ baseURL: VM });
  await other.post("/api/auth/login", { data: { name: "e2e-super", pin: E2E_PIN } });
  const panel = async () => (await other.get(`/api/events/${eventId}/devices`)).json();
  expect((await panel()).hub_url_warning).toEqual({ status: "unset", value: null });
  await other.post(`/api/devices/${hubDeviceId}/revoke`, { data: {} });
  // Hubs that earlier specs left linked still count: only without any is the warning gone.
  const after = await panel();
  const linked = (after.devices as { kind: string; revoked: boolean }[]).some(
    (d) => d.kind === "hub" && !d.revoked,
  );
  expect(after.hub_url_warning ?? null).toEqual(linked ? { status: "unset", value: null } : null);
  await other.dispose();
});

test("login that works but leaves no session, over plain http on a real name, says to use https", async ({
  page,
}) => {
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, contentType: "application/json", body: "{}" }),
  );
  await page.goto("http://e2e.localhost:3100/login");
  await page.getByPlaceholder("Name").fill("e2e-super");
  await page.getByPlaceholder("PIN").fill(E2E_PIN);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.locator(".login-card [role=alert]")).toHaveText(
    "Open this page with https:// — over plain http the browser drops the login.",
  );
});
