import { intParam, json, route } from "../../../../../server/http";
import { byMode } from "../../../../../server/mode";
import { eventStats } from "../../../../../server/stats";

export const dynamic = "force-dynamic";

const vmStats = route({ access: { staff: "staff" } }, async ({ ctx, params }) =>
  json(await eventStats(ctx, intParam(params, "id"))),
);

export const GET = byMode(
  vmStats,
  async () => (await import("../../../../../hub/dashboard")).stats,
);
