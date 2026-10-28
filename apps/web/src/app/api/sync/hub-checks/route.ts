import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { acceptHubChecks } from "../../../../server/hubSetup";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "hub", body: api.syncHubChecksRequest },
  async ({ ctx, device, body }) => json(await acceptHubChecks(ctx, device, body)),
);
