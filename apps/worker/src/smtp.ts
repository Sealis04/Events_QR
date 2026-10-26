import { connect, type Socket } from "node:net";
import { SendError, type MailSender } from "./gmail";
import { buildMime, type OutgoingEmail } from "./mime";

export interface SmtpOptions {
  host: string;
  port: number;
  /** Envelope and header sender. */
  sender: string;
  timeoutMs?: number;
}

interface Reply {
  code: number;
  text: string;
}

/** The bare address out of `Name <addr>` or `addr`; refuses anything that could break the SMTP line. */
function envelopeAddress(value: string): string {
  const m = /<([^<>]+)>\s*$/.exec(value);
  const addr = (m?.[1] ?? value).trim();
  if (!addr || /[\s<>]/.test(addr)) throw new SendError(`invalid address: ${value}`, true);
  return addr;
}

/** CRLF line endings, and a leading dot doubled on every line (RFC 5321 section 4.5.2). */
export function dotStuff(message: string): string {
  return message
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? "." + line : line))
    .join("\r\n");
}

/**
 * Plain SMTP without TLS or authentication, one connection per message. Only meant for a mail
 * catcher on the same Docker network (Mailpit in docker/compose.test.yml); production sends
 * through the Gmail API.
 */
export class SmtpSender implements MailSender {
  constructor(private readonly options: SmtpOptions) {}

  get address(): string {
    return this.options.sender;
  }

  async send(mail: OutgoingEmail): Promise<void> {
    const from = envelopeAddress(mail.from);
    const to = envelopeAddress(mail.to);
    const session = await SmtpSession.open(this.options);
    try {
      await session.expect(220);
      await session.command("EHLO events-qr", 250);
      await session.command(`MAIL FROM:<${from}>`, 250);
      await session.command(`RCPT TO:<${to}>`, 250, 251);
      await session.command("DATA", 354);
      await session.command(`${dotStuff(buildMime(mail))}\r\n.`, 250);
      await session.command("QUIT", 221).catch(() => undefined);
    } finally {
      session.close();
    }
  }
}

class SmtpSession {
  private buffer = "";
  private replies: Reply[] = [];
  private waiting?: { resolve: (r: Reply) => void; reject: (e: Error) => void };
  private failure?: Error;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(new SendError(`SMTP connection: ${err.message}`, false)));
    socket.on("close", () => this.fail(new SendError("SMTP connection closed", false)));
  }

  static open(options: SmtpOptions): Promise<SmtpSession> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      const socket = connect({ host: options.host, port: options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new SendError(`SMTP connect to ${options.host}:${options.port} timed out`, false));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(new SmtpSession(socket, timeoutMs));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(
          new SendError(`SMTP connect to ${options.host}:${options.port}: ${err.message}`, false),
        );
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // A reply is complete at a line whose fourth character is a space ("250 ok"), not "250-".
    for (;;) {
      const m = /^((?:\d{3}-[^\r\n]*\r\n)*)(\d{3})(?: [^\r\n]*)?\r\n/.exec(this.buffer);
      if (!m) break;
      this.buffer = this.buffer.slice(m[0].length);
      this.deliver({ code: Number(m[2]), text: m[0].trim() });
    }
  }

  private deliver(reply: Reply): void {
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.resolve(reply);
    } else {
      this.replies.push(reply);
    }
  }

  private fail(err: Error): void {
    this.failure ??= err;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = undefined;
      w.reject(err);
    }
  }

  private next(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new SendError("SMTP server did not answer", false));
      }, this.timeoutMs);
      this.waiting = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
    });
  }

  async expect(...codes: number[]): Promise<Reply> {
    const reply = await this.next();
    if (!codes.includes(reply.code)) {
      // 5xx is a permanent refusal (bad recipient, message rejected); 4xx and anything else may pass.
      throw new SendError(`SMTP ${reply.text}`, reply.code >= 500 && reply.code < 600);
    }
    return reply;
  }

  command(line: string, ...codes: number[]): Promise<Reply> {
    this.socket.write(`${line}\r\n`);
    return this.expect(...codes);
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }
}
