import { describe, expect, it } from "vitest";
import { api } from "../src";

const uuid = "0190f3a2-7b1c-7d2e-8a4b-1c2d3e4f5a6b";
const tid = "f0efeeedecebeae9e8e7e6e5e4e3e2e1";

describe("api schemas", () => {
  it("accepts a claim request and rejects bad ids", () => {
    const body = {
      scan_id: uuid,
      ticket_id: tid,
      device_id: uuid,
      gate: "Gate A",
      scanned_at: 1_800_000_000,
    };
    expect(api.claimRequest.parse(body)).toMatchObject({ gate: "Gate A" });
    expect(api.exitRequest.safeParse(body).success).toBe(true);
    expect(api.claimRequest.safeParse({ ...body, ticket_id: "XYZ" }).success).toBe(false);
    expect(api.claimRequest.safeParse({ ...body, scan_id: "nope" }).success).toBe(false);
  });

  it("covers every claim response", () => {
    for (const result of ["admitted", "rejected_used", "rejected_inside", "rejected_cancelled"]) {
      expect(api.claimResponse.safeParse({ result }).success).toBe(true);
    }
    expect(api.claimResponse.safeParse({ result: "maybe" }).success).toBe(false);
    expect(
      api.claimResponse.safeParse({
        result: "rejected_used",
        first_scan: { gate: "A", at: 1, device: uuid },
      }).success,
    ).toBe(true);
  });

  it("validates ticket generation requests (idempotency key required, entry rule consistent)", () => {
    const ok = { idempotency_key: "abcdefgh", ticket_type: 1, holder_name: "Ana" };
    expect(api.createTicketsRequest.parse(ok).quantity).toBe(1);
    expect(api.createTicketsRequest.safeParse({ ticket_type: 1 }).success).toBe(false);
    expect(api.createTicketsRequest.safeParse({ ...ok, quantity: 501 }).success).toBe(false);
    expect(
      api.createTicketsRequest.safeParse({ ...ok, entry_rule: { mode: "limited" } }).success,
    ).toBe(false);
    expect(
      api.createTicketsRequest.safeParse({ ...ok, entry_rule: { mode: "limited", max_admits: 3 } })
        .success,
    ).toBe(true);
    expect(
      api.createTicketsRequest.safeParse({ ...ok, entry_rule: { mode: "single", max_admits: 3 } })
        .success,
    ).toBe(false);
  });

  it("validates events: at most 16 gates, early entry 15-30", () => {
    const event = {
      name: "Fest",
      starts_at: 1,
      ends_at: 2,
      gates: ["A"],
      ticket_types: [{ idx: 0, name: "GA", early_entry_min: 15 }],
    };
    expect(api.createEventRequest.safeParse(event).success).toBe(true);
    expect(api.createEventRequest.safeParse({ ...event, gates: Array(17).fill("G") }).success).toBe(
      false,
    );
    expect(
      api.createEventRequest.safeParse({
        ...event,
        ticket_types: [{ idx: 0, name: "GA", early_entry_min: 31 }],
      }).success,
    ).toBe(false);
  });

  it("validates sync cursors and scan batches", () => {
    expect(api.syncTicketsQuery.parse({ cursor: `1800000000:${tid}`, limit: "100" }).limit).toBe(
      100,
    );
    expect(api.syncTicketsQuery.safeParse({ cursor: "bad" }).success).toBe(false);
    const scan = {
      scan_id: uuid,
      ticket_id: tid,
      device_id: uuid,
      gate: "A",
      direction: "entry",
      scanned_at: 1,
      result: "admitted",
      offline: false,
    };
    expect(api.syncScansRequest.safeParse({ scans: [scan] }).success).toBe(true);
    expect(api.syncScansRequest.safeParse({ scans: [] }).success).toBe(false);
    expect(api.syncScansRequest.safeParse({ scans: Array(501).fill(scan) }).success).toBe(false);
    expect(api.hubScansRequest.safeParse({ scans: [scan] }).success).toBe(true);
  });

  it("defines request and response schemas for every endpoint in the spec tables", () => {
    const names = [
      "createEventRequest",
      "createEventResponse",
      "createTicketsRequest",
      "createTicketsResponse",
      "cancelTicketRequest",
      "cancelTicketResponse",
      "resendTicketRequest",
      "resendTicketResponse",
      "createSetupRequest",
      "createSetupResponse",
      "enrollExchangeRequest",
      "enrollExchangeResponse",
      "syncTicketsQuery",
      "syncTicketsResponse",
      "syncScansRequest",
      "syncScansResponse",
      "eventStatsResponse",
      "claimRequest",
      "claimResponse",
      "exitRequest",
      "exitResponse",
      "hubSyncQuery",
      "hubSyncResponse",
      "hubScansRequest",
      "hubScansResponse",
      "healthResponse",
    ] as const;
    for (const n of names) expect(typeof api[n].safeParse, n).toBe("function");
  });

  it("round-trips enrolment and sync responses", () => {
    const bundle = {
      event_id: 1,
      event_key: "AAAA",
      public_keys: { "1": "BBBB" },
      gates: ["A"],
      starts_at: 1,
      ends_at: 2,
      day_zero: 0,
    };
    expect(
      api.enrollExchangeResponse.safeParse({
        device_id: uuid,
        device_token: "t",
        key_bundle: bundle,
        gate: "A",
        direction: "both",
        label: null,
      }).success,
    ).toBe(true);
    expect(
      api.hubSyncResponse.safeParse({
        tickets: [],
        devices: [{ id: uuid, gate: "A", direction: "exit", revoked: false }],
        next_cursor: null,
        has_more: false,
        hub_time: 5,
      }).success,
    ).toBe(true);
  });
});
