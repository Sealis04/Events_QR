import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { syncDevices } from "../../../../server/sync";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "hub", body: api.syncDevicesRequest },
  async ({ ctx, device, body }) => json(await syncDevices(ctx, device, body)),
);
