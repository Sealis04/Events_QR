import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  evaluateCertificate,
  evaluateDataMatch,
  evaluateDnsRecord,
  evaluateHubRunning,
  evaluateLinkHub,
  evaluateLocalDns,
  evaluateOfflineScan,
  evaluatePhoneViaHub,
  fixFor,
  HUB_FIX_CODES,
  type DataCounts,
  type HubDeviceView,
} from "../src";

const NOW = 1_800_000_000;
const DAY = 86_400;

describe("classifyAddress", () => {
  it("knows private, Cloudflare and public addresses", () => {
    expect(classifyAddress("192.168.50.10")).toBe("private");
    expect(classifyAddress("10.1.2.3")).toBe("private");
    expect(classifyAddress("172.16.0.1")).toBe("private");
    expect(classifyAddress("172.31.255.255")).toBe("private");
    expect(classifyAddress("172.32.0.1")).toBe("public");
    expect(classifyAddress("104.21.5.9")).toBe("cloudflare");
    expect(classifyAddress("172.67.1.1")).toBe("cloudflare");
    expect(classifyAddress("8.8.8.8")).toBe("public");
    expect(classifyAddress("fd12:3456::1")).toBe("private");
    expect(classifyAddress("2606:4700:3030::6815:1")).toBe("cloudflare");
    expect(classifyAddress("2001:4860:4860::8888")).toBe("public");
    expect(classifyAddress("not an ip")).toBe("invalid");
  });
});

describe("step 1: hub running", () => {
  const url = "https://hub.example.org";
  it("passes when the hub answers in hub mode", () => {
    const r = evaluateHubRunning({
      url,
      reached: true,
      status: 200,
      body: { ok: true, mode: "hub", last_cloud_sync_at: NOW, pending_scans: 0 },
    });
    expect(r.result).toBe("pass");
    expect(r.details.mode).toBe("hub");
  });
  it("fails when the hub is down", () => {
    const r = evaluateHubRunning({ url, reached: false, error: "Failed to fetch" });
    expect(r).toMatchObject({ result: "fail", code: "hub_unreachable" });
  });
  it("fails on an error status", () => {
    expect(evaluateHubRunning({ url, reached: true, status: 502 }).code).toBe("hub_bad_status");
  });
  it("fails when the address is the VM", () => {
    const r = evaluateHubRunning({ url, reached: true, status: 200, body: { mode: "server" } });
    expect(r.code).toBe("not_hub_mode");
  });
});

describe("step 2: DNS record", () => {
  const host = "hub.example.org";
  it("passes for a private answer", () => {
    expect(evaluateDnsRecord({ host, addresses: ["192.168.50.10"] }).result).toBe("pass");
  });
  it("fails with the grey-cloud fix for a Cloudflare answer", () => {
    const r = evaluateDnsRecord({ host, addresses: ["104.21.5.9", "172.67.1.1"] });
    expect(r).toMatchObject({ result: "fail", code: "dns_cloudflare_proxy" });
    expect(fixFor(r.code)?.text).toContain("turn the cloud grey");
  });
  it("fails with no record", () => {
    expect(evaluateDnsRecord({ host, addresses: [], error: "nxdomain" }).code).toBe(
      "dns_no_record",
    );
    expect(evaluateDnsRecord({ host, addresses: [] }).code).toBe("dns_no_record");
  });
  it("fails for a public address, and for a mix", () => {
    expect(evaluateDnsRecord({ host, addresses: ["8.8.8.8"] }).code).toBe("dns_public_address");
    expect(evaluateDnsRecord({ host, addresses: ["192.168.1.2", "8.8.8.8"] }).code).toBe(
      "dns_public_address",
    );
  });
  it("tells a lookup failure from a missing record", () => {
    expect(evaluateDnsRecord({ host, addresses: [], error: "ETIMEOUT" }).code).toBe(
      "dns_lookup_failed",
    );
  });
});

describe("step 3: certificate", () => {
  it("passes with plenty of days left (VM handshake)", () => {
    const r = evaluateCertificate({
      now: NOW,
      vmTls: { authorized: true, expiresAt: NOW + 80 * DAY },
    });
    expect(r).toMatchObject({ result: "pass", code: null });
    expect(r.details.days_left).toBe(80);
  });
  it("takes the pass from the browser when the VM cannot reach the hub", () => {
    const r = evaluateCertificate({
      now: NOW,
      browser: { reachedOverHttps: true, certExpiresAt: NOW + 60 * DAY },
    });
    expect(r.result).toBe("pass");
    expect(r.details.checked_by).toBe("browser");
  });
  it("warns under 30 days", () => {
    const r = evaluateCertificate({
      now: NOW,
      browser: { reachedOverHttps: true, certExpiresAt: NOW + 12 * DAY },
    });
    expect(r).toMatchObject({ result: "warn", code: "cert_expiring" });
  });
  it("fails when expired", () => {
    const r = evaluateCertificate({
      now: NOW,
      vmTls: { authorized: true, expiresAt: NOW - DAY },
    });
    expect(r.code).toBe("cert_expired");
  });
  it("fails when the VM sees an untrusted certificate", () => {
    const r = evaluateCertificate({
      now: NOW,
      vmTls: { authorized: false, expiresAt: NOW + 90 * DAY },
      browser: { reachedOverHttps: true, certExpiresAt: null },
    });
    expect(r.code).toBe("cert_not_trusted");
  });
  it("fails when nothing could reach the hub over https", () => {
    expect(evaluateCertificate({ now: NOW }).code).toBe("cert_unverified");
    expect(
      evaluateCertificate({
        now: NOW,
        browser: { reachedOverHttps: false, certExpiresAt: null },
      }).code,
    ).toBe("cert_unverified");
  });
  it("warns when it is trusted but the expiry is unknown", () => {
    const r = evaluateCertificate({
      now: NOW,
      browser: { reachedOverHttps: true, certExpiresAt: null },
    });
    expect(r).toMatchObject({ result: "warn", code: "cert_expiry_unknown" });
  });
});

describe("step 4: link the hub", () => {
  const hub = (over: Partial<HubDeviceView> = {}): HubDeviceView => ({
    id: "h1",
    label: "e2e hub",
    revoked: false,
    lastSeenAt: NOW - 20,
    lastPullAt: NOW - 20,
    ...over,
  });
  it("passes for a hub seen recently that has pulled", () => {
    expect(evaluateLinkHub({ now: NOW, hubs: [hub()] }).result).toBe("pass");
  });
  it("fails with no hub, a revoked hub, a stale hub, a hub that never pulled", () => {
    expect(evaluateLinkHub({ now: NOW, hubs: [] }).code).toBe("hub_not_linked");
    expect(evaluateLinkHub({ now: NOW, hubs: [hub({ revoked: true })] }).code).toBe("hub_revoked");
    expect(evaluateLinkHub({ now: NOW, hubs: [hub({ lastSeenAt: NOW - 600 })] }).code).toBe(
      "hub_not_seen",
    );
    expect(evaluateLinkHub({ now: NOW, hubs: [hub({ lastSeenAt: null })] }).code).toBe(
      "hub_not_seen",
    );
    expect(evaluateLinkHub({ now: NOW, hubs: [hub({ lastPullAt: null })] }).code).toBe(
      "hub_never_pulled",
    );
  });
  it("judges the most recently seen hub, not a replaced one", () => {
    const old = hub({ id: "old", lastSeenAt: NOW - 9000, lastPullAt: NOW - 9000 });
    const result = evaluateLinkHub({ now: NOW, hubs: [old, hub({ id: "new" })] });
    expect(result.result).toBe("pass");
    expect(result.details.device_id).toBe("new");
  });
});

describe("step 6: tickets and staff match", () => {
  const counts = (valid: number, staff = 3): DataCounts => ({
    tickets: { valid, used_up: 2, cancelled: 1 },
    staff,
  });
  const base = { now: NOW, pullIntervalSeconds: 30 };
  it("passes when equal", () => {
    const r = evaluateDataMatch({
      ...base,
      hub: counts(10),
      vm: counts(10),
      lastPullAt: NOW - 100,
    });
    expect(r.result).toBe("pass");
  });
  it("passes when the hub is behind by less than a pull interval", () => {
    const r = evaluateDataMatch({ ...base, hub: counts(8), vm: counts(10), lastPullAt: NOW - 12 });
    expect(r.result).toBe("pass");
    expect(r.summary).toContain("2 tickets behind");
  });
  it("fails when the hub is behind and has not pulled for a while", () => {
    const r = evaluateDataMatch({ ...base, hub: counts(8), vm: counts(10), lastPullAt: NOW - 300 });
    expect(r.code).toBe("data_stale");
  });
  it("fails when the hub has never pulled", () => {
    const r = evaluateDataMatch({ ...base, hub: counts(0, 0), vm: counts(10), lastPullAt: null });
    expect(r.code).toBe("data_never_pulled");
  });
  it("fails on a mismatch a pull cannot explain", () => {
    expect(
      evaluateDataMatch({ ...base, hub: counts(12), vm: counts(10), lastPullAt: NOW - 5 }).code,
    ).toBe("data_mismatch");
    expect(
      evaluateDataMatch({ ...base, hub: counts(10, 4), vm: counts(10, 3), lastPullAt: NOW - 5 })
        .code,
    ).toBe("data_mismatch");
  });
});

describe("step 7: a phone through the hub", () => {
  it("passes when a phone reported in the last 5 minutes", () => {
    const r = evaluatePhoneViaHub({
      now: NOW,
      phones: [
        { label: "Gate A phone", gate: "Gate A", lastSeenAt: NOW - 40 },
        { label: null, gate: "Gate B", lastSeenAt: NOW - 4000 },
      ],
    });
    expect(r.result).toBe("pass");
    expect(r.details.recent).toBe(1);
  });
  it("fails with no phones and with quiet phones", () => {
    expect(evaluatePhoneViaHub({ now: NOW, phones: [] }).code).toBe("no_phones");
    expect(
      evaluatePhoneViaHub({
        now: NOW,
        phones: [{ label: "x", gate: "A", lastSeenAt: NOW - 301 }],
      }).code,
    ).toBe("phone_quiet");
    expect(
      evaluatePhoneViaHub({ now: NOW, phones: [{ label: "x", gate: "A", lastSeenAt: null }] }).code,
    ).toBe("phone_quiet");
  });
});

describe("step 8: offline scan", () => {
  const started = NOW - 600;
  it("passes when a scan reached the hub during an outage and the VM got it later", () => {
    const r = evaluateOfflineScan({
      now: NOW,
      startedAt: started,
      outages: [{ from: NOW - 500, to: NOW - 200 }],
      scans: [{ receivedAt: NOW - 400, ackedAt: NOW - 190 }],
    });
    expect(r.result).toBe("pass");
    expect(r.details).toMatchObject({ scan_received_at: NOW - 400, vm_received_at: NOW - 190 });
  });
  it("fails when the test was never started", () => {
    const r = evaluateOfflineScan({ now: NOW, startedAt: null, outages: [], scans: [] });
    expect(r.code).toBe("offline_not_tested");
  });
  it("fails when the uplink never went down", () => {
    const r = evaluateOfflineScan({
      now: NOW,
      startedAt: started,
      outages: [{ from: started - 5000, to: started - 4000 }],
      scans: [{ receivedAt: NOW - 400, ackedAt: NOW - 390 }],
    });
    expect(r.code).toBe("offline_no_outage");
  });
  it("fails when no scan fell inside the outage", () => {
    const r = evaluateOfflineScan({
      now: NOW,
      startedAt: started,
      outages: [{ from: NOW - 500, to: NOW - 200 }],
      scans: [{ receivedAt: NOW - 100, ackedAt: NOW - 90 }],
    });
    expect(r.code).toBe("offline_no_scan");
  });
  it("ignores a scan the VM already had before the outage ended", () => {
    const r = evaluateOfflineScan({
      now: NOW,
      startedAt: started,
      outages: [{ from: NOW - 500, to: NOW - 200 }],
      scans: [{ receivedAt: NOW - 480, ackedAt: NOW - 475 }],
    });
    expect(r.code).toBe("offline_no_scan");
  });
  it("fails while the VM has not received the scan, even if the uplink is still down", () => {
    const r = evaluateOfflineScan({
      now: NOW,
      startedAt: started,
      outages: [{ from: NOW - 500, to: null }],
      scans: [{ receivedAt: NOW - 400, ackedAt: null }],
    });
    expect(r.code).toBe("offline_not_delivered");
  });
});

describe("fix texts", () => {
  it("exist for every failure code a step can produce", () => {
    for (const code of [
      "hub_unreachable",
      "hub_bad_status",
      "not_hub_mode",
      "dns_no_record",
      "dns_cloudflare_proxy",
      "dns_public_address",
      "dns_lookup_failed",
      "cert_not_trusted",
      "cert_unverified",
      "cert_expired",
      "cert_expiring",
      "cert_expiry_unknown",
      "hub_not_linked",
      "hub_revoked",
      "hub_not_seen",
      "hub_never_pulled",
      "local_dns_unreachable",
      "local_dns_wrong_target",
      "data_never_pulled",
      "data_stale",
      "data_mismatch",
      "no_phones",
      "phone_quiet",
      "offline_not_tested",
      "offline_no_outage",
      "offline_no_scan",
      "offline_not_delivered",
    ]) {
      expect(HUB_FIX_CODES, code).toContain(code);
    }
  });
  it("link to a setup guide section where one applies", () => {
    expect(fixFor("dns_cloudflare_proxy")?.url).toContain("#44-cloudflare-record");
    expect(fixFor("local_dns_unreachable")?.url).toContain("#46-");
  });
  it("evaluateLocalDns separates unreachable from wrong target", () => {
    const url = "https://hub.example.org";
    expect(evaluateLocalDns({ url, reached: false }).code).toBe("local_dns_unreachable");
    expect(
      evaluateLocalDns({ url, reached: true, status: 200, body: { mode: "server" } }).code,
    ).toBe("local_dns_wrong_target");
    expect(
      evaluateLocalDns({ url, reached: true, status: 200, body: { mode: "hub" } }).result,
    ).toBe("pass");
  });
});
