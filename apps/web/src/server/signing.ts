/**
 * The only module that touches the Ed25519 secret key.
 *
 * The key file is JSON. Secret keys are AES-256-GCM encrypted under a key derived from the
 * passphrase with scrypt; public keys are stored in clear. Each generation has a `key_id`, which
 * is the `key_id` byte in tickets. Older generations keep their secret so tickets of events that
 * span a rotation can still be re-sent byte for byte; `retireKey` drops a secret (its public key
 * stays valid for verification, but nothing can be minted with it any more).
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { generateSigningKeyPair, mintToken, type TicketPayload } from "@events-qr/core";
import { b64, fromB64 } from "./secrets";

const FILE_VERSION = 1;
const SCRYPT = { N: 1 << 15, r: 8, p: 1 } as const;

interface KeyEntry {
  key_id: number;
  public_key: string;
  /** `nonce:ciphertext||tag`, base64. Absent once the key is retired. */
  secret?: string;
}

interface KeyFile {
  version: typeof FILE_VERSION;
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number };
  current_key_id: number;
  keys: KeyEntry[];
}

export class SigningKeyUnavailable extends Error {
  constructor(keyId: number) {
    super(`signing key ${keyId} is not available (retired or missing)`);
  }
}

function deriveKey(passphrase: string, kdf: KeyFile["kdf"]): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      Buffer.from(kdf.salt, "base64"),
      32,
      { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  );
}

const aad = (keyId: number) => Buffer.from(`events-qr/signing-key/v1/${keyId}`);

function seal(secret: Uint8Array, key: Buffer, keyId: number): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad(keyId));
  const ct = Buffer.concat([cipher.update(secret), cipher.final(), cipher.getAuthTag()]);
  return `${nonce.toString("base64")}:${ct.toString("base64")}`;
}

function open(sealed: string, key: Buffer, keyId: number): Uint8Array {
  const [nonce, ct] = sealed.split(":");
  if (!nonce || !ct) throw new Error("malformed signing key entry");
  const data = Buffer.from(ct, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64"));
  decipher.setAAD(aad(keyId));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return new Uint8Array(
    Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]),
  );
}

/** Writes a temp file next to the target and renames it over, so readers never see a partial file. */
async function writeKeyFile(path: string, file: KeyFile): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function readKeyFile(path: string): Promise<KeyFile> {
  const file = JSON.parse(await readFile(path, "utf8")) as KeyFile;
  if (file.version !== FILE_VERSION) throw new Error("unsupported signing key file version");
  return file;
}

/** Creates the key file with generation 1 (or `keyId`). Refuses to overwrite. */
export async function createSigningKeyFile(
  path: string,
  passphrase: string,
  keyId = 1,
): Promise<{ keyId: number; publicKey: string }> {
  if (
    await readFile(path).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(`${path} already exists; refusing to overwrite`);
  }
  const kdf = { name: "scrypt" as const, salt: b64(randomBytes(16)), ...SCRYPT };
  const key = await deriveKey(passphrase, kdf);
  const pair = await generateSigningKeyPair();
  await writeKeyFile(path, {
    version: FILE_VERSION,
    kdf,
    current_key_id: keyId,
    keys: [
      { key_id: keyId, public_key: b64(pair.publicKey), secret: seal(pair.privateKey, key, keyId) },
    ],
  });
  return { keyId, publicKey: b64(pair.publicKey) };
}

/** Adds a new generation and makes it current. Older secrets stay unless retired. */
export async function rotateSigningKey(
  path: string,
  passphrase: string,
): Promise<{ keyId: number; publicKey: string }> {
  const file = await readKeyFile(path);
  const key = await deriveKey(passphrase, file.kdf);
  // Prove the passphrase is right before changing anything.
  const sample = file.keys.find((k) => k.secret);
  if (sample?.secret) open(sample.secret, key, sample.key_id);
  const keyId = Math.max(...file.keys.map((k) => k.key_id)) + 1;
  if (keyId > 255) throw new Error("key_id is one byte; no generations left");
  const pair = await generateSigningKeyPair();
  file.keys.push({
    key_id: keyId,
    public_key: b64(pair.publicKey),
    secret: seal(pair.privateKey, key, keyId),
  });
  file.current_key_id = keyId;
  await writeKeyFile(path, file);
  return { keyId, publicKey: b64(pair.publicKey) };
}

/** Drops the secret of an older generation; its public key keeps verifying existing tickets. */
export async function retireSigningKey(path: string, keyId: number): Promise<void> {
  const file = await readKeyFile(path);
  if (file.current_key_id === keyId) throw new Error("cannot retire the current key");
  const entry = file.keys.find((k) => k.key_id === keyId);
  if (!entry) throw new Error(`no key ${keyId}`);
  delete entry.secret;
  await writeKeyFile(path, file);
}

/** Key generations in the file, and whether each still has its secret. */
export async function listSigningKeys(
  path: string,
): Promise<{ currentKeyId: number; keys: { keyId: number; hasSecret: boolean }[] }> {
  const file = await readKeyFile(path);
  return {
    currentKeyId: file.current_key_id,
    keys: file.keys.map((k) => ({ keyId: k.key_id, hasSecret: !!k.secret })),
  };
}

export class Signer {
  private constructor(
    readonly currentKeyId: number,
    private readonly secrets: Map<number, Uint8Array>,
    private readonly publics: Map<number, Uint8Array>,
    private readonly path?: string,
  ) {}

  static async load(path: string, passphrase: string): Promise<Signer> {
    const file = await readKeyFile(path);
    const key = await deriveKey(passphrase, file.kdf);
    const secrets = new Map<number, Uint8Array>();
    const publics = new Map<number, Uint8Array>();
    for (const entry of file.keys) {
      publics.set(entry.key_id, fromB64(entry.public_key));
      if (entry.secret) secrets.set(entry.key_id, open(entry.secret, key, entry.key_id));
    }
    if (!secrets.has(file.current_key_id)) throw new Error("current signing key has no secret");
    return new Signer(file.current_key_id, secrets, publics, path);
  }

  /** In-memory signer for tests. */
  static fromKeyPairs(
    currentKeyId: number,
    pairs: { keyId: number; publicKey: Uint8Array; privateKey?: Uint8Array }[],
  ): Signer {
    const secrets = new Map<number, Uint8Array>();
    const publics = new Map<number, Uint8Array>();
    for (const p of pairs) {
      publics.set(p.keyId, p.publicKey);
      if (p.privateKey) secrets.set(p.keyId, p.privateKey);
    }
    return new Signer(currentKeyId, secrets, publics);
  }

  /**
   * Whether `keyId` can still mint. A signer backed by a file re-reads it first, because the
   * worker deletes secrets of finished events' key generations from another process.
   */
  async canMint(keyId: number): Promise<boolean> {
    if (this.path) {
      const { keys } = await listSigningKeys(this.path);
      if (!keys.some((k) => k.keyId === keyId && k.hasSecret)) this.secrets.delete(keyId);
    }
    return this.secrets.has(keyId);
  }

  /** Public keys by `key_id`, for verification and for the device key bundle. */
  publicKeys(): Map<number, Uint8Array> {
    return new Map(this.publics);
  }

  /** Signs the payload (its `keyId` picks the generation) and encrypts it under the event key. */
  async mint(payload: TicketPayload, eventKey: Uint8Array, nonce?: Uint8Array): Promise<string> {
    const secret = this.secrets.get(payload.keyId);
    if (!secret) throw new SigningKeyUnavailable(payload.keyId);
    return mintToken(payload, secret, eventKey, nonce);
  }
}
