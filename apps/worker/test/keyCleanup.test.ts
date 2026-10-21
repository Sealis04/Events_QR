import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { api, mysqlSchema } from "@events-qr/core";
import { createEvent } from "@events-qr/web/server/events";
import {
  createSigningKeyFile,
  listSigningKeys,
  rotateSigningKey,
  Signer,
} from "@events-qr/web/server/signing";
import { issueTickets, resendTicket } from "@events-qr/web/server/tickets";
import { cleanupSigningKeys } from "../src/keyCleanup";
import {
  createTestEnv,
  dbAvailable,
  eventBody,
  makeStaff,
  newKey,
  type TestEnv,
} from "../../web/test/helpers";

const { events } = mysqlSchema;

describe.skipIf(!dbAvailable)("signing key cleanup (MariaDB)", () => {
  let env: TestEnv;
  let dir: string;
  let path: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "eqr-keys-"));
    path = join(dir, "key.json");
    await createSigningKeyFile(path, "pw");
    env = await createTestEnv({ SIGNING_KEY_PATH: path, SIGNING_KEY_PASSPHRASE: "pw" });
    env.ctx.signer = await Signer.load(path, "pw");
  });
  afterAll(async () => {
    await env.close();
    await rm(dir, { recursive: true, force: true });
  });

  const hasSecret = async (keyId: number) =>
    (await listSigningKeys(path)).keys.find((k) => k.keyId === keyId)!.hasSecret;

  it("keeps a generation while an event using it has not ended, then retires it", async () => {
    const admin = await makeStaff(env, "admin");
    const { id: eventId } = await createEvent(
      env.ctx,
      api.createEventRequest.parse(eventBody(env.clock.now + 3600)),
    );
    const ticket = (
      await issueTickets(
        env.ctx,
        eventId,
        api.createTicketsRequest.parse({
          idempotency_key: newKey(),
          ticket_type: 0,
          holder_name: "Old key",
          holder_email: "a@b.org",
        }),
        { id: admin.id, role: "admin" },
      )
    ).tickets[0]!;

    await rotateSigningKey(path, "pw"); // key 2 is current, key 1 still signs the event above
    env.ctx.signer = await Signer.load(path, "pw");

    expect(await cleanupSigningKeys(env.ctx)).toEqual([]);
    expect(await hasSecret(1)).toBe(true);

    env.clock.now += 7 * 3600; // the event is over
    expect(await cleanupSigningKeys(env.ctx)).toEqual([1]);
    expect(await hasSecret(1)).toBe(false);
    expect(await hasSecret(2)).toBe(true); // current key is never retired
    expect(await cleanupSigningKeys(env.ctx)).toEqual([]); // idempotent

    // Re-send of a ticket under the retired key is a clear 409, not a 500.
    await expect(resendTicket(env.ctx, ticket.ticket_id)).rejects.toMatchObject({
      status: 409,
      code: "signing_key_retired",
    });
    const [row] = await env.handle.db.select().from(events).where(eq(events.id, eventId));
    expect(row!.signKeyId).toBe(1);
  });
});
