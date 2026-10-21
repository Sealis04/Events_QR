import { api } from "@events-qr/core";
import { createEvent, listEvents } from "../../../server/events";
import { json, route } from "../../../server/http";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "staff" } }, async ({ ctx }) =>
  json(await listEvents(ctx)),
);

/** Admin creates an event; its AES-256 key is generated and stored encrypted under EVENT_KEY_MASTER. */
export const POST = route(
  { access: { staff: "admin" }, body: api.createEventRequest },
  async ({ ctx, body }) => json(await createEvent(ctx, body), 201),
);
