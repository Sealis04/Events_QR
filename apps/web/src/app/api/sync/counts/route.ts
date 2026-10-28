import { json, route } from "../../../../server/http";
import { vmCounts } from "../../../../server/hubSetup";

export const dynamic = "force-dynamic";

export const GET = route({ access: "hub" }, async ({ ctx, device }) =>
  json(await vmCounts(ctx, device)),
);
