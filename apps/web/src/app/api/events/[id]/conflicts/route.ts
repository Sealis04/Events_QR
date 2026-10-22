import { api } from "@events-qr/core";
import { intParam, json, route } from "../../../../../server/http";
import { listConflicts } from "../../../../../server/stats";

export const dynamic = "force-dynamic";

export const GET = route(
  { access: { staff: "supervisor" }, query: api.conflictsQuery },
  async ({ ctx, params, query }) => json(await listConflicts(ctx, intParam(params, "id"), query)),
);
