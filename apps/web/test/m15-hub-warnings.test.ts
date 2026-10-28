import { describe, expect, it } from "vitest";
import { encodeSetupCode } from "@events-qr/core";
import { hubUrlWarningText } from "../src/app/_lib/hubSetup";
import { noSessionMessage } from "../src/app/_lib/loginHelp";
import { EnrollFailed, enrollFromSetupQr } from "../src/scanner/sync";
import { MemoryStore } from "../src/scanner/memoryStore";
import { classifyHubUrl, hubUrlWarning } from "../src/server/hubUrl";
import { createFixtures, DEVICE_ID, EVENT_ID } from "./scanner-fixtures";

describe("HUB_URL classifier", () => {
  it.each([
    [undefined, "unset"],
    ["", "unset"],
    ["  ", "unset"],
    ["http://localhost:3000", "local"],
    ["https://localhost", "local"],
    ["https://127.0.0.1", "local"],
    ["https://127.5.0.9:3100", "local"],
    ["https://host.docker.internal:3100", "local"],
    ["https://192.168.0.10", "local"],
    ["https://[::1]", "local"],
    ["http://testhub.example.gov.ph", "local"],
    ["not a url", "local"],
    ["https://testhub.example.gov.ph", "ok"],
    ["https://hub.example.gov.ph:8443/", "ok"],
  ] as const)("%s -> %s", (value, expected) => {
    expect(classifyHubUrl(value)).toBe(expected);
  });
});

describe("hub URL warning", () => {
  it("is shown only with a linked (not revoked) hub and a HUB_URL that is not ok", () => {
    const live = [{ revoked: false }];
    expect(hubUrlWarning({ HUB_URL: undefined }, live)).toEqual({ status: "unset", value: null });
    expect(hubUrlWarning({ HUB_URL: "http://localhost:3000" }, live)).toEqual({
      status: "local",
      value: "http://localhost:3000",
    });
    expect(hubUrlWarning({ HUB_URL: "https://hub.example.gov.ph" }, live)).toBeNull();
    expect(hubUrlWarning({ HUB_URL: undefined }, [])).toBeNull();
    expect(hubUrlWarning({ HUB_URL: undefined }, [{ revoked: true }])).toBeNull();
  });

  it("names HUB_URL and what to set", () => {
    expect(hubUrlWarningText({ status: "unset", value: null })).toBe(
      "Phones set up from this page will not find the hub: HUB_URL is unset. Set HUB_URL=https://<hub name> in the server's .env and restart it.",
    );
    expect(hubUrlWarningText({ status: "local", value: "http://localhost:3000" })).toContain(
      "HUB_URL is http://localhost:3000.",
    );
  });
});

describe("login message when no session follows", () => {
  it("asks for https on a non-localhost http page", () => {
    expect(noSessionMessage({ protocol: "http:", hostname: "testhub.example.gov.ph" })).toBe(
      "Open this page with https:// — over plain http the browser drops the login.",
    );
  });
  it("keeps the supervisors message on localhost and on https", () => {
    const sup = "This server only lets supervisors and admins into the dashboard.";
    expect(noSessionMessage({ protocol: "http:", hostname: "localhost" })).toBe(sup);
    expect(noSessionMessage({ protocol: "http:", hostname: "127.0.0.1" })).toBe(sup);
    expect(noSessionMessage({ protocol: "https:", hostname: "hub.example.gov.ph" })).toBe(sup);
  });
});

describe("phone setup when neither server can send tickets", () => {
  it("names both addresses and leaves the phone not set up", async () => {
    const fx = await createFixtures();
    const dev = fx.device();
    const hub = "http://localhost:3000";
    const cloud = "http://host.docker.internal:3000";
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input);
      if (url === `${hub}/api/devices/enroll`) {
        return Response.json({
          device_id: DEVICE_ID,
          device_token: `${DEVICE_ID}.secret`,
          key_bundle: { ...dev.bundle, cloud_url: cloud },
          gate: "Gate A",
          direction: "both",
          label: null,
        });
      }
      throw new TypeError("fetch failed");
    };
    const store = new MemoryStore();
    const qr = encodeSetupCode({ eventId: EVENT_ID, code: "abcdefghijkl", hubUrl: hub });
    const err = await enrollFromSetupQr(store, qr, { fetch: fetchFn, newId: () => DEVICE_ID }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EnrollFailed);
    const failed = err as EnrollFailed;
    expect(failed.reason).toBe("sync_failed");
    expect(failed.message).toContain(hub);
    expect(failed.message).toContain(cloud);
    expect(failed.message).toContain("Check HUB_URL on the server");
    expect(failed.message).toContain("new one");
    expect(await store.getDevice()).toBeUndefined();
  });
});
