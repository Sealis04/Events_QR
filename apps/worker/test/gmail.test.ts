import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GmailSender, SendError } from "../src/gmail";
import { buildMime, type OutgoingEmail } from "../src/mime";

const mail: OutgoingEmail = {
  from: "tickets@example.org",
  to: "guest@example.org",
  subject: "Your ticket for Summer Fest",
  text: "Hello Jane",
  html: '<p>Hello Jane</p><img src="cid:ticket-qr">',
  inline: [
    {
      cid: "ticket-qr",
      contentType: "image/png",
      filename: "ticket.png",
      data: new Uint8Array([137, 80, 78, 71]),
    },
  ],
};

describe("buildMime", () => {
  it("builds multipart/related with text, html and an inline image", () => {
    const raw = buildMime(mail);
    expect(raw).toContain("To: guest@example.org");
    expect(raw).toContain("Content-Type: multipart/related");
    expect(raw).toContain("Content-Type: multipart/alternative");
    expect(raw).toContain("Content-ID: <ticket-qr>");
    expect(raw).toContain("Content-Disposition: inline");
    expect(raw).toContain(`=?UTF-8?B?${Buffer.from(mail.subject).toString("base64")}?=`);
    expect(raw.split("\r\n").every((line) => line.length <= 998)).toBe(true);
  });

  it("cannot be used to inject headers through subject or addresses", () => {
    const raw = buildMime({
      ...mail,
      subject: "Hi\r\nBcc: evil@example.org",
      to: "a@example.org\r\nBcc: evil@example.org",
    });
    expect(raw.split("\r\n").filter((l) => /^bcc:/i.test(l))).toEqual([]);
  });
});

describe("GmailSender", () => {
  let dir: string;
  let keyPath: string;
  let publicKey: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "eqr-gmail-"));
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    publicKey = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    keyPath = join(dir, "sa.json");
    await writeFile(
      keyPath,
      JSON.stringify({
        client_email: "svc@project.iam.gserviceaccount.com",
        private_key: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        token_uri: "https://oauth.test/token",
      }),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  function fakeGoogle(opts: { sendStatus?: () => number } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const http: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      if (String(url) === "https://oauth.test/token") {
        return Response.json({ access_token: `tok-${calls.length}`, expires_in: 3600 });
      }
      const status = opts.sendStatus?.() ?? 200;
      return status === 200
        ? Response.json({ id: "m1" })
        : Response.json({ error: { message: `status ${status}` } }, { status });
    };
    return { http, calls };
  }
  const sender = (http: typeof fetch, now = () => 1_800_000_000) =>
    new GmailSender({ keyPath, sender: "tickets@example.org", fetch: http, now });

  it("signs a delegation JWT for the sender mailbox and posts the raw message", async () => {
    const g = fakeGoogle();
    await sender(g.http).send(mail);

    const tokenReq = g.calls[0]!;
    const form = new URLSearchParams(String(tokenReq.init.body));
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [h, c, s] = form.get("assertion")!.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toMatchObject({
      iss: "svc@project.iam.gserviceaccount.com",
      sub: "tickets@example.org",
      scope: "https://www.googleapis.com/auth/gmail.send",
      aud: "https://oauth.test/token",
      iat: 1_800_000_000,
    });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, s, "base64url")).toBe(
      true,
    );

    const sendReq = g.calls[1]!;
    expect(sendReq.url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
    expect((sendReq.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    const raw = Buffer.from(JSON.parse(String(sendReq.init.body)).raw, "base64url").toString();
    expect(raw).toContain("To: guest@example.org");
    expect(raw).toContain("Content-ID: <ticket-qr>");
  });

  it("reuses the access token until it nears expiry", async () => {
    const g = fakeGoogle();
    let now = 1_800_000_000;
    const s = sender(g.http, () => now);
    await s.send(mail);
    await s.send(mail);
    expect(g.calls.filter((c) => c.url.includes("oauth.test"))).toHaveLength(1);
    now += 3600;
    await s.send(mail);
    expect(g.calls.filter((c) => c.url.includes("oauth.test"))).toHaveLength(2);
  });

  it("treats 400 as permanent and 429/500/401 as retryable", async () => {
    for (const [status, permanent] of [
      [400, true],
      [404, true],
      [429, false],
      [500, false],
      [401, false],
    ] as const) {
      const g = fakeGoogle({ sendStatus: () => status });
      const err = await sender(g.http)
        .send(mail)
        .catch((e) => e);
      expect(err).toBeInstanceOf(SendError);
      expect((err as SendError).permanent, String(status)).toBe(permanent);
    }
  });

  it("fails clearly when the token request is refused", async () => {
    const http: typeof fetch = async () =>
      Response.json({ error_description: "unauthorized_client" }, { status: 401 });
    await expect(sender(http).send(mail)).rejects.toThrow(/unauthorized_client/);
  });
});
