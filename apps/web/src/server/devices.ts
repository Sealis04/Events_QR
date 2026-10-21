import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { api, encodeSetupCode, mysqlSchema } from "@events-qr/core";
import type { AppContext } from "./context";
import { affectedRows, isDuplicate } from "./dbutil";
import { badRequest, conflict, HttpError } from "./http";
import { keyBundle, loadEvent, loadTypes } from "./events";
import { randomToken, sha256Hex } from "./secrets";

const { devices, enrolmentCodes } = mysqlSchema;

export const SETUP_TTL_SECONDS = 10 * 60;

/** Step 1: a supervisor creates a setup QR. The one-time code is stored only as a SHA-256. */
export async function createSetup(
  ctx: AppContext,
  staffId: string,
  input: z.infer<typeof api.createSetupRequest>,
  fallbackUrl: string,
): Promise<z.infer<typeof api.createSetupResponse>> {
  const event = await loadEvent(ctx.db, input.event_id);
  if (!event.gates.includes(input.gate))
    throw badRequest(`"${input.gate}" is not a gate of this event`);
  const code = randomToken(12);
  const now = ctx.now();
  const expiresAt = now + SETUP_TTL_SECONDS;
  await ctx.db.insert(enrolmentCodes).values({
    eventId: event.id,
    codeHash: sha256Hex(code),
    gate: input.gate,
    direction: input.direction,
    label: input.label ?? null,
    createdBy: staffId,
    createdAt: now,
    expiresAt,
  });
  return {
    setup_qr: encodeSetupCode({
      eventId: event.id,
      code,
      hubUrl: ctx.config.HUB_URL ?? fallbackUrl,
    }),
    expires_at: expiresAt,
  };
}

const invalidCode = () =>
  new HttpError(401, "invalid_code", "setup code is invalid, expired or already used");

/**
 * Step 2: exchange the one-time code for a device token and key bundle. The phone picks its
 * `device_id`; if the response was lost it can retry within the setup window with the same id and
 * gets a fresh token (the old one stops working).
 */
export async function exchangeEnrolment(
  ctx: AppContext,
  input: z.infer<typeof api.enrollExchangeRequest>,
): Promise<z.infer<typeof api.enrollExchangeResponse>> {
  const now = ctx.now();
  const codeHash = sha256Hex(input.code);
  const token = `${input.device_id}.${randomToken(32)}`;

  const result = await ctx.db.transaction(async (tx) => {
    const [code] = await tx
      .select()
      .from(enrolmentCodes)
      .where(eq(enrolmentCodes.codeHash, codeHash))
      .for("update")
      .limit(1);
    if (!code) throw invalidCode();

    if (code.usedAt !== null) {
      const retry = code.deviceId === input.device_id && now <= code.usedAt + SETUP_TTL_SECONDS;
      if (!retry) throw invalidCode();
      const [res] = await tx
        .update(devices)
        .set({ tokenHash: sha256Hex(token) })
        .where(and(eq(devices.id, input.device_id), eq(devices.revoked, false)));
      if (affectedRows(res) !== 1) throw invalidCode();
    } else {
      if (code.expiresAt < now) throw invalidCode();
      try {
        await tx.insert(devices).values({
          id: input.device_id,
          eventId: code.eventId,
          label: code.label,
          gate: code.gate,
          direction: code.direction,
          tokenHash: sha256Hex(token),
          lastSeenAt: now,
        });
      } catch (err) {
        if (isDuplicate(err)) throw conflict("device_exists", "that device id is already enrolled");
        throw err;
      }
      await tx
        .update(enrolmentCodes)
        .set({ usedAt: now, deviceId: input.device_id })
        .where(eq(enrolmentCodes.id, code.id));
    }
    return code;
  });

  const event = await loadEvent(ctx.db, result.eventId);
  return {
    device_id: input.device_id,
    device_token: token,
    key_bundle: keyBundle(ctx, event, await loadTypes(ctx.db, event.id)),
    gate: result.gate,
    direction: result.direction as "entry" | "exit" | "both",
    label: result.label,
  };
}
