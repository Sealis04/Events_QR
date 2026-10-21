// Smoke test: mint a token and verify it. Run with `bun scripts/mint-verify.ts`.
import {
  encodeEntryRule,
  generateEventKey,
  generateSigningKeyPair,
  mintToken,
  verifyToken,
} from "../packages/core/src";

const { publicKey, privateKey } = await generateSigningKeyPair();
const eventKey = generateEventKey();
const payload = {
  version: 1,
  eventId: 1,
  ticketId: crypto.getRandomValues(new Uint8Array(16)),
  ticketType: 0,
  issuedAt: Math.floor(Date.now() / 1000),
  keyId: 1,
  entryRule: encodeEntryRule("single"),
  gateMask: 0,
  slotStart: 0xffff,
  slotEnd: 0xffff,
};
const token = await mintToken(payload, privateKey, eventKey);
console.log(token, token.length);
console.log(await verifyToken(token, new Map([[1, publicKey]]), eventKey, 1));
