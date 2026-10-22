import { api } from "@events-qr/core";
import { claimTicket } from "../../../server/claim";
import { json, route } from "../../../server/http";
import { byMode } from "../../../server/mode";

export const dynamic = "force-dynamic";

export const POST = byMode(
  route({ access: "device", body: api.claimRequest }, async ({ ctx, device, body }) =>
    json(await claimTicket(ctx, device, body)),
  ),
  async () => (await import("../../../hub/routes")).claim,
);
