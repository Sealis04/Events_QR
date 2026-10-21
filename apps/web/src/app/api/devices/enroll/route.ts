import { z } from "zod";
import { api } from "@events-qr/core";
import { createSetup, exchangeEnrolment } from "../../../../server/devices";
import { json, requireStaff, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

/**
 * Two steps on one path, as in the spec's API table. A body with `code` is a device exchanging its
 * one-time code (the code is the credential); a body with `event_id` is a supervisor creating a setup QR.
 */
const body = z.union([api.enrollExchangeRequest, api.createSetupRequest]);

export const POST = route({ access: "public", body }, async ({ req, ctx, body }) => {
  if ("code" in body) return json(await exchangeEnrolment(ctx, body));
  const staff = await requireStaff(ctx, req, "supervisor");
  const url = new URL(req.url);
  const origin = `${req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host
  }`;
  return json(await createSetup(ctx, staff.id, body, origin), 201);
});
