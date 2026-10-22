import { gt } from "drizzle-orm";
import { mysqlSchema } from "@events-qr/core";
import type { AppContext } from "@events-qr/web/server/context";
import { listSigningKeys, retireSigningKey } from "@events-qr/web/server/signing";

const { events } = mysqlSchema;

export const KEY_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Deletes the secret of every non-current key generation once no event signed with it has an
 * `ends_at` in the future. Public keys stay, so issued tickets keep verifying. Returns the key ids
 * retired. Safe to run from several workers: retiring twice is a no-op.
 */
export async function cleanupSigningKeys(ctx: AppContext): Promise<number[]> {
  const path = ctx.config.SIGNING_KEY_PATH;
  if (!path) return [];
  const { currentKeyId, keys } = await listSigningKeys(path);
  const candidates = keys
    .filter((k) => k.hasSecret && k.keyId !== currentKeyId)
    .map((k) => k.keyId);
  if (candidates.length === 0) return [];

  const upcoming = await ctx.db
    .selectDistinct({ keyId: events.signKeyId })
    .from(events)
    .where(gt(events.endsAt, ctx.now()))
    .then((rows) => rows.filter((r) => candidates.includes(r.keyId)));
  const inUse = new Set(upcoming.map((r) => r.keyId));

  const retired: number[] = [];
  for (const keyId of candidates) {
    if (inUse.has(keyId)) continue;
    try {
      await retireSigningKey(path, keyId);
      retired.push(keyId);
    } catch (err) {
      // Lost a race with another worker or a rotate; the next pass decides again.
      console.error(`worker: could not retire signing key ${keyId}`, err);
    }
  }
  // Forget the secrets in memory too.
  for (const keyId of retired) await ctx.signer.canMint(keyId);
  return retired;
}
