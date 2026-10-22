import { hexParam, json, route } from "../../../../server/http";
import { ticketDetail } from "../../../../server/tickets";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "staff" } }, async ({ ctx, params }) =>
  json(await ticketDetail(ctx, hexParam(params, "id"))),
);
