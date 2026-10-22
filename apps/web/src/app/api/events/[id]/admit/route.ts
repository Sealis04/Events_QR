import { api } from "@events-qr/core";
import { manualAdmit } from "../../../../../server/dashboard";
import { intParam, json, route } from "../../../../../server/http";
import { byMode } from "../../../../../server/mode";

export const dynamic = "force-dynamic";

const vmAdmit = route(
  { access: { staff: "supervisor" }, body: api.manualAdmitRequest },
  async ({ ctx, staff, params, body }) =>
    json(await manualAdmit(ctx, staff, intParam(params, "id"), body)),
);

export const POST = byMode(
  vmAdmit,
  async () => (await import("../../../../../hub/dashboard")).admit,
);
