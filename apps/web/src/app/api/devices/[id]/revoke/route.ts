import { api } from "@events-qr/core";
import { previewRevoke, revokeDevice } from "../../../../../server/deviceAdmin";
import { json, route } from "../../../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "supervisor" }, body: api.revokeDeviceRequest },
  async ({ ctx, params, body }) => json(await revokeDevice(ctx, params.id!, body.rotate ?? false)),
);

/** Dry run for the revoke dialog; changes nothing. */
export const GET = route({ access: { staff: "supervisor" } }, async ({ ctx, params }) =>
  json(await previewRevoke(ctx, params.id!)),
);
