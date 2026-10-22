import { api } from "@events-qr/core";
import { updateDevice } from "../../../../server/deviceAdmin";
import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const PATCH = route(
  { access: { staff: "supervisor" }, body: api.updateDeviceRequest },
  async ({ ctx, params, body }) => {
    await updateDevice(ctx, params.id!, body);
    return json({ ok: true });
  },
);
