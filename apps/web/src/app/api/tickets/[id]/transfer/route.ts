import { api } from "@events-qr/core";
import { hexParam, json, route } from "../../../../../server/http";
import { transferTicket } from "../../../../../server/tickets";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.transferTicketRequest },
  async ({ ctx, staff, params, body }) =>
    json(await transferTicket(ctx, hexParam(params, "id"), body, staff), 201),
);
