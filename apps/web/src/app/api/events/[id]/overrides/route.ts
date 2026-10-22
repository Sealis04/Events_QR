import { listOverrides } from "../../../../../server/dashboard";
import { intParam, json, route } from "../../../../../server/http";
import { byMode } from "../../../../../server/mode";

export const dynamic = "force-dynamic";

const vmOverrides = route({ access: { staff: "supervisor" } }, async ({ ctx, params }) =>
  json(await listOverrides(ctx, intParam(params, "id"))),
);

export const GET = byMode(
  vmOverrides,
  async () => (await import("../../../../../hub/dashboard")).overrides,
);
