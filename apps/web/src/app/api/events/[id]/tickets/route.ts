import { z } from "zod";
import { api } from "@events-qr/core";
import { intParam, json, route } from "../../../../../server/http";
import { issueTickets, listTickets } from "../../../../../server/tickets";

export const dynamic = "force-dynamic";

const listQuery = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route(
  { access: { staff: "staff" }, query: listQuery },
  async ({ ctx, params, query }) =>
    json({ tickets: await listTickets(ctx, intParam(params, "id"), query) }),
);

/** The QR generator. Any staff member; `issued_by` records who. Replays of a key return the same tickets. */
export const POST = route(
  { access: { staff: "staff" }, body: api.createTicketsRequest },
  async ({ ctx, staff, params, body }) => {
    const result = await issueTickets(ctx, intParam(params, "id"), body, staff);
    return json({ tickets: result.tickets }, result.created ? 201 : 200);
  },
);
