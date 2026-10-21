import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildMime, type OutgoingEmail } from "./mime";

/** Sending is behind this interface so tests (and any other provider) can stand in for Gmail. */
export interface MailSender {
  send(mail: OutgoingEmail): Promise<void>;
}

/** `permanent` errors (bad recipient, malformed message) are not retried. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

export interface GmailOptions {
  /** Service-account JSON key (mounted file, never committed). */
  keyPath: string;
  /** The mailbox to send as; the service account needs domain-wide delegation for the gmail.send scope. */
  sender: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Gmail API through a Workspace service account with domain-wide delegation. */
export class GmailSender implements MailSender {
  private key?: ServiceAccountKey;
  private token?: { value: string; expiresAt: number };
  private readonly http: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GmailOptions) {
    this.http = options.fetch ?? fetch;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  get address(): string {
    return this.options.sender;
  }

  private async accessToken(): Promise<string> {
    const now = this.now();
    if (this.token && this.token.expiresAt - 60 > now) return this.token.value;
    this.key ??= JSON.parse(await readFile(this.options.keyPath, "utf8")) as ServiceAccountKey;
    const aud = this.key.token_uri ?? "https://oauth2.googleapis.com/token";
    const encode = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: this.key.client_email,
        sub: this.options.sender,
        scope: SCOPE,
        aud,
        iat: now,
        exp: now + 3600,
      });
    const assertion =
      unsigned +
      "." +
      createSign("RSA-SHA256").update(unsigned).sign(this.key.private_key, "base64url");
    const res = await this.http(aud, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new SendError(
        `Gmail token request failed (${res.status}): ${body.error_description ?? "no detail"}`,
        false,
      );
    }
    this.token = { value: body.access_token, expiresAt: now + (body.expires_in ?? 3600) };
    return body.access_token;
  }

  async send(mail: OutgoingEmail): Promise<void> {
    const raw = Buffer.from(buildMime(mail)).toString("base64url");
    const res = await this.http(SEND_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ raw }),
    });
    if (res.ok) return;
    const detail = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error
      ?.message;
    if (res.status === 401) this.token = undefined; // refresh next time
    // Bad request / not found are about the message itself; everything else (429, 5xx, auth) can recover.
    throw new SendError(
      `Gmail send failed (${res.status}): ${detail ?? "no detail"}`,
      res.status === 400 || res.status === 404,
    );
  }
}
