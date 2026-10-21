import { api } from "@events-qr/core";
import { hexParam, json, route } from "../../../../../server/http";
import { cancelTicket } from "../../../../../server/tickets";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.cancelTicketRequest },
  async ({ ctx, params }) => json(await cancelTicket(ctx, hexParam(params, "id"))),
);
