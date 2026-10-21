import { describe, expect, it } from "vitest";
import { decodeSetupCode, encodeSetupCode, SETUP_PREFIX } from "../src";

describe("DEV1 setup code", () => {
  const setup = { eventId: 4242, code: "K7Q2-MX9P", hubUrl: "https://hub.example.org" };

  it("round-trips event id, code and hub URL", () => {
    const text = encodeSetupCode(setup);
    expect(text.startsWith(SETUP_PREFIX)).toBe(true);
    expect(decodeSetupCode(text)).toEqual({ ok: true, setup });
  });
  it("handles non-ASCII hub URLs and the largest event id", () => {
    const s = { eventId: 0xffffffff, code: "x", hubUrl: "https://höb.example/ü" };
    expect(decodeSetupCode(encodeSetupCode(s))).toEqual({ ok: true, setup: s });
  });
  it("uses only the QR alphanumeric alphabet", () => {
    expect(encodeSetupCode(setup)).toMatch(/^DEV1:[0-9A-Z $%*+\-./:]+$/);
  });
  it("carries no key material: body is just id, code and URL", () => {
    expect(encodeSetupCode(setup).length).toBeLessThan(120);
  });
  it("reports typed errors", () => {
    expect(decodeSetupCode("EVT1:ABC")).toEqual({ ok: false, error: "not_setup" });
    expect(decodeSetupCode("")).toEqual({ ok: false, error: "not_setup" });
    expect(decodeSetupCode("DEV1:")).toEqual({ ok: false, error: "invalid" });
    expect(decodeSetupCode("DEV1:!!!")).toEqual({ ok: false, error: "invalid" });
    const truncated = encodeSetupCode(setup).slice(0, -3);
    expect(decodeSetupCode(truncated)).toEqual({ ok: false, error: "invalid" });
  });
  it("rejects values that do not fit", () => {
    expect(() => encodeSetupCode({ ...setup, code: "" })).toThrow();
    expect(() => encodeSetupCode({ ...setup, eventId: -1 })).toThrow();
  });
});
