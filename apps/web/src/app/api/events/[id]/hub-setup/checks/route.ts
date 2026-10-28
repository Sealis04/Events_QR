import { api } from "@events-qr/core";
import { intParam, json, route } from "../../../../../../server/http";
import { runHubCheck } from "../../../../../../server/hubSetup";
import { byMode } from "../../../../../../server/mode";

export const dynamic = "force-dynamic";

const vmRun = route(
  { access: { staff: "admin" }, body: api.hubCheckRequest },
  async ({ ctx, staff, params, body }) =>
    json(await runHubCheck(ctx, staff, intParam(params, "id"), body)),
);

export const POST = byMode(
  vmRun,
  async () => (await import("../../../../../../hub/hubSetup")).hubRunCheckRoute,
);
