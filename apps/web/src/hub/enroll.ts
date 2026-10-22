/**
 * `POST /enroll` on the hub: a phone exchanges the one-time code from its `DEV1:` QR for a device
 * token and the key bundle, using the codes the hub cached from the VM, so it works with no
 * internet. The new device is queued for the VM (`pushDevices`), which makes its token valid there
 * too. Same shapes and the same retry rule as the VM's exchange (src/server/devices.ts).
 */
import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import { api, sqliteSchema } from "@events-qr/core";
import { SETUP_TTL_SECONDS } from "../server/constants";
import { conflict, HttpError } from "../server/errors";
import { randomToken, sha256Hex } from "../server/secrets";
import { immediate, type HubContext } from "./context";
import { getBundle, getState } from "./state";

const { devices, enrolmentCodes, hubDeviceOutbox, ticketTypes, events } = sqliteSchema;

const invalidCode = () =>
  new HttpError(401, "invalid_code", "setup code is invalid, expired or already used");

export function exchangeHubEnrolment(
  ctx: HubContext,
  input: z.infer<typeof api.enrollExchangeRequest>,
): z.infer<typeof api.enrollExchangeResponse> {
  const bundle = getBundle(ctx);
  if (!bundle)
    throw new HttpError(503, "hub_not_linked", "this hub is not set up for an event yet");
  const now = ctx.now();
  const codeHash = sha256Hex(input.code);
  const token = `${input.device_id}.${randomToken(32)}`;

  const code = immediate(ctx, () => {
    const found = ctx.db
      .select()
      .from(enrolmentCodes)
      .where(eq(enrolmentCodes.codeHash, codeHash))
      .get();
    if (!found || found.kind !== "scanner") throw invalidCode();

    if (found.usedAt !== null) {
      // The response may have been lost: the same phone may retry within the setup window.
      const retry = found.deviceId === input.device_id && now <= found.usedAt + SETUP_TTL_SECONDS;
      if (!retry) throw invalidCode();
      const res = ctx.db
        .update(devices)
        .set({ tokenHash: sha256Hex(token) })
        .where(and(eq(devices.id, input.device_id), eq(devices.revoked, false)))
        .run();
      if (res.changes !== 1) throw invalidCode();
      // A retry before the VM heard about the device must push the new token hash, not the old.
      ctx.db
        .update(hubDeviceOutbox)
        .set({ ackedAt: null })
        .where(eq(hubDeviceOutbox.deviceId, input.device_id))
        .run();
    } else {
      if (found.expiresAt < now) throw invalidCode();
      if (ctx.db.select().from(devices).where(eq(devices.id, input.device_id)).get())
        throw conflict("device_exists", "that device id is already enrolled");
      ctx.db
        .insert(devices)
        .values({
          id: input.device_id,
          eventId: found.eventId,
          label: found.label,
          gate: found.gate,
          direction: found.direction,
          tokenHash: sha256Hex(token),
          lastSeenAt: now,
        })
        .run();
      ctx.db
        .update(enrolmentCodes)
        .set({ usedAt: now, deviceId: input.device_id })
        .where(eq(enrolmentCodes.id, found.id))
        .run();
      ctx.db
        .insert(hubDeviceOutbox)
        .values({ deviceId: input.device_id, codeHash, usedAt: now })
        .run();
    }
    return found;
  });

  const event = ctx.db.select().from(events).where(eq(events.id, code.eventId)).get();
  const types = ctx.db
    .select()
    .from(ticketTypes)
    .where(eq(ticketTypes.eventId, code.eventId))
    .orderBy(asc(ticketTypes.idx))
    .all();
  const cloudUrl = bundle.cloud_url ?? getState(ctx, "vm_url");
  return {
    device_id: input.device_id,
    device_token: token,
    key_bundle: {
      ...bundle,
      gates: event?.gates ?? bundle.gates,
      ticket_types: types.map((t) => ({
        idx: t.idx,
        name: t.name,
        early_entry_min: t.earlyEntryMin,
      })),
      ...(cloudUrl ? { cloud_url: cloudUrl } : {}),
    },
    gate: code.gate,
    direction: code.direction as "entry" | "exit" | "both",
    label: code.label,
  };
}
