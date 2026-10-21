import { api } from "@events-qr/core";
import { hexParam, json, route } from "../../../../../server/http";
import { resendTicket } from "../../../../../server/tickets";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.resendTicketRequest },
  async ({ ctx, params, body }) =>
    json(await resendTicket(ctx, hexParam(params, "id"), body.email)),
);
