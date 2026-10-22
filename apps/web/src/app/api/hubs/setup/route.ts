import { api } from "@events-qr/core";
import { createHubSetup } from "../../../../server/devices";
import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

/** A supervisor creates the one-time code that binds a venue hub to an event. */
export const POST = route(
  { access: { staff: "supervisor" }, body: api.hubSetupRequest },
  async ({ ctx, staff, body }) => json(await createHubSetup(ctx, staff.id, body), 201),
);
