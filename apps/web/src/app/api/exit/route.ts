import { api } from "@events-qr/core";
import { exitTicket } from "../../../server/claim";
import { json, route } from "../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "device", body: api.exitRequest },
  async ({ ctx, device, body }) => json(await exitTicket(ctx, device, body)),
);
