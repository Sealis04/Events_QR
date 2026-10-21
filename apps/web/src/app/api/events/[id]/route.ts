import { api } from "@events-qr/core";
import { getEventView, updateEvent } from "../../../../server/events";
import { intParam, json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "staff" } }, async ({ ctx, params }) =>
  json(await getEventView(ctx, intParam(params, "id"))),
);

export const PATCH = route(
  { access: { staff: "admin" }, body: api.updateEventRequest },
  async ({ ctx, params, body }) => {
    const id = intParam(params, "id");
    await updateEvent(ctx, id, body);
    return json(await getEventView(ctx, id));
  },
);
