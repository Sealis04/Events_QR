/**
 * Encryption at rest for the phone's IndexedDB (docs/spec.md "Security": the event key and ticket
 * list sit in encrypted IndexedDB). One AES-256-GCM key per install, created non-extractable by
 * WebCrypto: script can use it but never read its bytes, and a copy of the database file or a
 * backup cannot be opened without it. It is held as a `CryptoKey` object in IndexedDB. Each record
 * gets its own random IV and is bound to its store and id through the GCM additional data, so a
 * record cannot be moved to another slot.
 */
export interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
}

export const newBoxKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return { iv, ct };
}

export async function open<T>(key: CryptoKey, aad: string, box: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: box.iv, additionalData: enc.encode(aad) },
    key,
    box.ct,
  );
  return JSON.parse(dec.decode(plain)) as T;
}
