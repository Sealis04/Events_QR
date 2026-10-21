/**
 * Creates the passphrase-encrypted Ed25519 signing key file, rotates it, or retires an old generation.
 *   bun scripts/gen-signing-key.ts                 # new file at $SIGNING_KEY_PATH
 *   bun scripts/gen-signing-key.ts --rotate        # add a generation and make it current
 *   bun scripts/gen-signing-key.ts --retire 1      # drop generation 1's secret (public key stays valid)
 * Reads SIGNING_KEY_PATH and SIGNING_KEY_PASSPHRASE from the environment (.env).
 */
import { parseArgs } from "node:util";
import {
  createSigningKeyFile,
  retireSigningKey,
  rotateSigningKey,
} from "../apps/web/src/server/signing";

const { values } = parseArgs({
  options: { rotate: { type: "boolean" }, retire: { type: "string" } },
});
const path = process.env.SIGNING_KEY_PATH;
const passphrase = process.env.SIGNING_KEY_PASSPHRASE;
if (!path || !passphrase) throw new Error("set SIGNING_KEY_PATH and SIGNING_KEY_PASSPHRASE");

if (values.retire !== undefined) {
  await retireSigningKey(path, Number(values.retire));
  console.log(
    `retired key ${values.retire}: its secret is gone, its public key still verifies tickets`,
  );
} else if (values.rotate) {
  const { keyId, publicKey } = await rotateSigningKey(path, passphrase);
  console.log(`added key ${keyId} (public ${publicKey}); new events will use it`);
} else {
  const { keyId, publicKey } = await createSigningKeyFile(path, passphrase);
  console.log(`wrote ${path} with key ${keyId} (public ${publicKey})`);
}
