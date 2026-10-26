import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { findRepoRoot, loadConfig } from "../src/server/config";

describe("file path settings", () => {
  it("resolves relative paths against the repo root, not the cwd", () => {
    const config = loadConfig(
      { SIGNING_KEY_PATH: ".secrets/signing-key.json", GMAIL_SA_KEY_PATH: "sa/key.json" },
      "/srv/repo",
    );
    expect(config.SIGNING_KEY_PATH).toBe(resolve("/srv/repo", ".secrets/signing-key.json"));
    expect(config.GMAIL_SA_KEY_PATH).toBe(resolve("/srv/repo", "sa/key.json"));
  });

  it("leaves absolute paths alone", () => {
    const config = loadConfig({ SIGNING_KEY_PATH: "/run/secrets/key.json" }, "/srv/repo");
    expect(config.SIGNING_KEY_PATH).toBe("/run/secrets/key.json");
  });

  it("finds the repo root from apps/web", () => {
    const root = findRepoRoot(process.cwd());
    expect(findRepoRoot(join(root, "apps", "web"))).toBe(root);
    expect(loadConfig({ SIGNING_KEY_PATH: "k.json" }).SIGNING_KEY_PATH).toBe(join(root, "k.json"));
  });
});

describe("test copy settings", () => {
  it("defaults to Gmail and no instance label", () => {
    const config = loadConfig({}, "/srv/repo");
    expect(config.MAIL_TRANSPORT).toBe("gmail");
    expect(config.INSTANCE_LABEL).toBeUndefined();
    expect(config.SMTP_PORT).toBe(1025);
  });

  it("reads the test copy's label and SMTP settings", () => {
    const config = loadConfig(
      {
        INSTANCE_LABEL: " TEST ",
        MAIL_TRANSPORT: "smtp",
        SMTP_HOST: "mailpit",
        SMTP_PORT: "2525",
        MAIL_FROM: "tickets-test@example.org",
      },
      "/srv/repo",
    );
    expect(config.INSTANCE_LABEL).toBe("TEST");
    expect(config.MAIL_TRANSPORT).toBe("smtp");
    expect(config.SMTP_HOST).toBe("mailpit");
    expect(config.SMTP_PORT).toBe(2525);
  });

  it("rejects an unknown mail transport", () => {
    expect(() => loadConfig({ MAIL_TRANSPORT: "postmark" }, "/srv/repo")).toThrow(/MAIL_TRANSPORT/);
  });
});
