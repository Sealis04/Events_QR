import { z } from "zod";
import { api } from "@events-qr/core";
import { createSetup, exchangeEnrolment } from "../../../../server/devices";
import { json, requestOrigin, requireStaff, route } from "../../../../server/http";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

/**
 * Two steps on one path, as in the spec's API table. A body with `code` is a device exchanging its
 * one-time code (the code is the credential); a body with `event_id` is a supervisor creating a setup QR.
 */
const body = z.union([api.enrollExchangeRequest, api.createSetupRequest]);

const vmEnroll = route({ access: "public", body }, async ({ req, ctx, body }) => {
  if ("code" in body)
    return json(
      await exchangeEnrolment(ctx, body, { cloudUrl: ctx.config.PUBLIC_URL ?? requestOrigin(req) }),
    );
  const staff = await requireStaff(ctx, req, "supervisor");
  return json(await createSetup(ctx, staff.id, body, requestOrigin(req)), 201);
});

/** On a hub only the exchange step exists: the codes are made on the VM. */
export const POST = byMode(vmEnroll, async () => (await import("../../../../hub/routes")).enroll);
