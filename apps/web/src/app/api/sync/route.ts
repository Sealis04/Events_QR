import { api } from "@events-qr/core";
import { json, route } from "../../../server/http";
import { syncForDevice } from "../../../server/sync";

export const dynamic = "force-dynamic";

export const GET = route(
  { access: "device", query: api.hubSyncQuery },
  async ({ ctx, device, query }) => json(await syncForDevice(ctx, device, query)),
);
