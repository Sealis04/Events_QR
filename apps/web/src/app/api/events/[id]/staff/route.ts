import { intParam, json, route } from "../../../../../server/http";
import { listEventStaff } from "../../../../../server/eventStaff";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "admin" } }, async ({ ctx, params }) =>
  json({ staff: await listEventStaff(ctx, intParam(params, "id")) }),
);
