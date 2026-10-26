import { intParam, json, route } from "../../../../../server/http";
import { hubSetupView } from "../../../../../server/hubSetup";
import { byMode } from "../../../../../server/mode";

export const dynamic = "force-dynamic";

const vmView = route({ access: { staff: "admin" } }, async ({ ctx, params }) =>
  json(await hubSetupView(ctx, intParam(params, "id"))),
);

export const GET = byMode(
  vmView,
  async () => (await import("../../../../../hub/hubSetup")).hubSetupViewRoute,
);
