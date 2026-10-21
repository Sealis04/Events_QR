import { api } from "@events-qr/core";
import { getEventView, updateTicketType } from "../../../../../../server/events";
import { intParam, json, route } from "../../../../../../server/http";

export const dynamic = "force-dynamic";

export const PATCH = route(
  { access: { staff: "admin" }, body: api.updateTicketTypeRequest },
  async ({ ctx, params, body }) => {
    const id = intParam(params, "id");
    const idx = intParam(params, "idx");
    await updateTicketType(ctx, id, idx, body);
    const view = await getEventView(ctx, id);
    return json(view.ticket_types.find((t) => t.idx === idx));
  },
);
