import { api } from "@events-qr/core";
import { exitTicket } from "../../../server/claim";
import { json, route } from "../../../server/http";
import { byMode } from "../../../server/mode";

export const dynamic = "force-dynamic";

export const POST = byMode(
  route({ access: "device", body: api.exitRequest }, async ({ ctx, device, body }) =>
    json(await exitTicket(ctx, device, body)),
  ),
  async () => (await import("../../../hub/routes")).exit,
);
