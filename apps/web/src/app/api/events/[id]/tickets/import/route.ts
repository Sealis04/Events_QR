import { api } from "@events-qr/core";
import { importTickets } from "../../../../../../server/csv";
import { intParam, json, route } from "../../../../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.importTicketsRequest },
  async ({ ctx, staff, params, body }) =>
    json(await importTickets(ctx, intParam(params, "id"), body, staff)),
);
