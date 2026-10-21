import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { syncScans } from "../../../../server/sync";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "device", body: api.syncScansRequest },
  async ({ ctx, device, body }) => json(await syncScans(ctx, device, body)),
);
