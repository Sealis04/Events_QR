import { api } from "@events-qr/core";
import { getEventView, updateEvent } from "../../../../server/events";
import { intParam, json, route } from "../../../../server/http";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

const vmView = route({ access: { staff: "staff" } }, async ({ ctx, params }) =>
  json(await getEventView(ctx, intParam(params, "id"))),
);

export const GET = byMode(
  vmView,
  async () => (await import("../../../../hub/dashboard")).eventView,
);

export const PATCH = route(
  { access: { staff: "admin" }, body: api.updateEventRequest },
  async ({ ctx, params, body }) => {
    const id = intParam(params, "id");
    await updateEvent(ctx, id, body);
    return json(await getEventView(ctx, id));
  },
);
