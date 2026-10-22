import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { syncScans, syncVmScans } from "../../../../server/sync";

export const dynamic = "force-dynamic";

/** The hub uploads its scans (and those of its phones). Hub tokens only (#5). */
export const POST = route(
  { access: "hub", body: api.syncScansRequest },
  async ({ ctx, device, body }) => json(await syncScans(ctx, device, body)),
);

/** The hub reads back what the VM holds (scans the VM decided itself while the hub was away). */
export const GET = route(
  { access: "hub", query: api.syncVmScansQuery },
  async ({ ctx, device, query }) => json(await syncVmScans(ctx, device, query)),
);
