import { api } from "@events-qr/core";
import { json, route } from "../../../server/http";
import { byMode } from "../../../server/mode";
import { uploadPhoneScans } from "../../../server/sync";

export const dynamic = "force-dynamic";

/**
 * A phone uploads the scans it decided offline (its outbox). On the hub this is the hub API's
 * `POST /scans`; on the VM it is the phone-scoped twin that accepts only the caller's own scans.
 */
export const POST = byMode(
  route({ access: "device", body: api.syncScansRequest }, async ({ ctx, device, body }) =>
    json(await uploadPhoneScans(ctx, device, body)),
  ),
  async () => (await import("../../../hub/routes")).scans,
);
