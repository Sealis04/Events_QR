import { api } from "@events-qr/core";
import { claimTicket } from "../../../server/claim";
import { json, route } from "../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "device", body: api.claimRequest },
  async ({ ctx, device, body }) => json(await claimTicket(ctx, device, body)),
);
