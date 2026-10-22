import { api } from "@events-qr/core";
import { intParam, json, route } from "../../../../../server/http";
import { byMode } from "../../../../../server/mode";
import { listConflicts } from "../../../../../server/stats";

export const dynamic = "force-dynamic";

const vmConflicts = route(
  { access: { staff: "supervisor" }, query: api.conflictsQuery },
  async ({ ctx, params, query }) => json(await listConflicts(ctx, intParam(params, "id"), query)),
);

export const GET = byMode(
  vmConflicts,
  async () => (await import("../../../../../hub/dashboard")).conflicts,
);
