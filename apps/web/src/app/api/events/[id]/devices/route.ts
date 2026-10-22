import { devicePanel } from "../../../../../server/deviceAdmin";
import { intParam, json, route } from "../../../../../server/http";
import { byMode } from "../../../../../server/mode";

export const dynamic = "force-dynamic";

const vmPanel = route({ access: { staff: "supervisor" } }, async ({ ctx, params }) =>
  json(await devicePanel(ctx, intParam(params, "id"))),
);

export const GET = byMode(
  vmPanel,
  async () => (await import("../../../../../hub/dashboard")).devices,
);
