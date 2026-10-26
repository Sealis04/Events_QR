import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { SendError } from "../src/gmail";
import type { OutgoingEmail } from "../src/mime";
import { dotStuff, SmtpSender } from "../src/smtp";
import { subjectFor } from "../src/emailQueue";

const mail: OutgoingEmail = {
  from: "tickets-test@example.org",
  to: "Jane Guest <guest@example.org>",
  subject: "[TEST] Your ticket for Summer Fest",
  text: "Hello Jane\n.hidden line",
  html: "<p>Hello Jane</p>",
  inline: [],
};

interface Fake {
  server: Server;
  port: number;
  commands: string[];
  data: string[];
}

/** A tiny SMTP server: answers each command from `replies` (by verb), records what it got. */
async function fakeSmtp(replies: Partial<Record<string, string>> = {}): Promise<Fake> {
  const commands: string[] = [];
  const data: string[] = [];
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    socket.write("220 fake.smtp ready\r\n");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write(replies.DOT ?? "250 queued\r\n");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        commands.push(line);
        const verb = (line.split(/[\s:]/)[0] ?? "").toUpperCase();
        if (verb === "EHLO") socket.write(replies.EHLO ?? "250-fake.smtp\r\n250 SIZE 1000000\r\n");
        else if (verb === "DATA") {
          const r = replies.DATA ?? "354 go ahead\r\n";
          socket.write(r);
          if (r.startsWith("354")) inData = true;
        } else if (verb === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write(replies[verb] ?? "250 ok\r\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port, commands, data };
}

let fake: Fake | undefined;
afterEach(async () => {
  if (fake) await new Promise((r) => fake!.server.close(r));
  fake = undefined;
});

describe("SmtpSender", () => {
  it("sends one message with a clean envelope and a dot-stuffed body", async () => {
    fake = await fakeSmtp();
    const sender = new SmtpSender({ host: "127.0.0.1", port: fake.port, sender: mail.from });
    await sender.send(mail);
    expect(fake.commands).toEqual([
      "EHLO events-qr",
      "MAIL FROM:<tickets-test@example.org>",
      "RCPT TO:<guest@example.org>",
      "DATA",
      "QUIT",
    ]);
    expect(fake.data).toHaveLength(1);
    expect(fake.data[0]).toContain("To: Jane Guest <guest@example.org>");
    expect(fake.data[0]).toContain("Subject: =?UTF-8?B?");
  });

  it("treats a 5xx refusal as permanent", async () => {
    fake = await fakeSmtp({ RCPT: "550 no such user\r\n" });
    const sender = new SmtpSender({ host: "127.0.0.1", port: fake.port, sender: mail.from });
    const err = await sender.send(mail).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).permanent).toBe(true);
    expect((err as SendError).message).toMatch(/550/);
  });

  it("treats a 4xx answer as temporary", async () => {
    fake = await fakeSmtp({ MAIL: "451 try later\r\n" });
    const sender = new SmtpSender({ host: "127.0.0.1", port: fake.port, sender: mail.from });
    const err = await sender.send(mail).catch((e: unknown) => e);
    expect((err as SendError).permanent).toBe(false);
  });

  it("treats an unreachable server as temporary", async () => {
    fake = await fakeSmtp();
    const port = fake.port;
    await new Promise((r) => fake!.server.close(r));
    fake = undefined;
    const sender = new SmtpSender({ host: "127.0.0.1", port, sender: mail.from, timeoutMs: 2000 });
    const err = await sender.send(mail).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as SendError).permanent).toBe(false);
  });

  it("refuses an address that could break the SMTP line", async () => {
    const sender = new SmtpSender({ host: "127.0.0.1", port: 1, sender: mail.from });
    const err = await sender.send({ ...mail, to: "a@b.org>\r\nRCPT TO:<x@y.org" }).catch((e) => e);
    expect((err as SendError).permanent).toBe(true);
  });
});

describe("dotStuff", () => {
  it("normalises line endings and doubles leading dots", () => {
    expect(dotStuff("a\n.b\r\n..c\n")).toBe("a\r\n..b\r\n...c\r\n");
  });
});

describe("subjectFor", () => {
  it("marks emails from a labelled copy", () => {
    expect(subjectFor("TEST", "Your ticket")).toBe("[TEST] Your ticket");
    expect(subjectFor(undefined, "Your ticket")).toBe("Your ticket");
  });
});
