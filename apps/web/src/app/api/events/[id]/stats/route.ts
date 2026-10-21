import { intParam, json, route } from "../../../../../server/http";
import { eventStats } from "../../../../../server/stats";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "staff" } }, async ({ ctx, params }) =>
  json(await eventStats(ctx, intParam(params, "id"))),
);
