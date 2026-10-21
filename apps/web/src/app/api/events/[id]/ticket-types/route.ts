import { api } from "@events-qr/core";
import { addTicketType, getEventView } from "../../../../../server/events";
import { intParam, json, route } from "../../../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.addTicketTypeRequest },
  async ({ ctx, params, body }) => {
    const id = intParam(params, "id");
    const idx = await addTicketType(ctx, id, body);
    const view = await getEventView(ctx, id);
    return json(
      view.ticket_types.find((t) => t.idx === idx),
      201,
    );
  },
);
