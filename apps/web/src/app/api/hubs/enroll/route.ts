import { api } from "@events-qr/core";
import { exchangeEnrolment } from "../../../../server/devices";
import { json, requestOrigin, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

/** The hub exchanges its setup code for a credential and the event key bundle (public keys only). */
export const POST = route({ access: "public", body: api.enrollExchangeRequest }, async (a) =>
  json(await exchangeEnrolment(a.ctx, a.body, { kind: "hub", cloudUrl: requestOrigin(a.req) })),
);
