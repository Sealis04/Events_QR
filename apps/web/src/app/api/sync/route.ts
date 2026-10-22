import { api } from "@events-qr/core";
import { json, route } from "../../../server/http";
import { byMode } from "../../../server/mode";
import { syncForDevice } from "../../../server/sync";

export const dynamic = "force-dynamic";

export const GET = byMode(
  route({ access: "device", query: api.hubSyncQuery }, async ({ ctx, device, query }) =>
    json(await syncForDevice(ctx, device, query)),
  ),
  async () => (await import("../../../hub/routes")).sync,
);
