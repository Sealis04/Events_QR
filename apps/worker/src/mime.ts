export interface InlineImage {
  cid: string;
  contentType: string;
  filename: string;
  data: Uint8Array;
}

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  inline: InlineImage[];
}

const b64 = (data: Uint8Array | string): string => Buffer.from(data).toString("base64");
/** Base64 wrapped at 76 characters, as MIME requires. */
const wrap = (text: string): string => text.replace(/(.{76})/g, "$1\r\n");
const header = (value: string): string => value.replace(/[\r\n]+/g, " ");

/** RFC 2047 encoded word, so subjects may hold any characters and can't inject headers. */
const encodedWord = (text: string): string => `=?UTF-8?B?${b64(header(text))}?=`;

/** multipart/related( multipart/alternative(text, html), inline images ). */
export function buildMime(mail: OutgoingEmail): string {
  const rel = "rel_" + Math.random().toString(36).slice(2);
  const alt = "alt_" + Math.random().toString(36).slice(2);
  const lines: string[] = [
    `From: ${header(mail.from)}`,
    `To: ${header(mail.to)}`,
    `Subject: ${encodedWord(mail.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/related; boundary="${rel}"`,
    "",
    `--${rel}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(mail.text)),
    `--${alt}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap(b64(mail.html)),
    `--${alt}--`,
  ];
  for (const img of mail.inline) {
    lines.push(
      `--${rel}`,
      `Content-Type: ${img.contentType}; name="${header(img.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${header(img.filename)}"`,
      "",
      wrap(b64(img.data)),
    );
  }
  lines.push(`--${rel}--`, "");
  return lines.join("\r\n");
}
