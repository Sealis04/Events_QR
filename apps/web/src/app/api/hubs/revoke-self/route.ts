import { revokeSelf } from "../../../../server/deviceAdmin";
import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

/** A venue hub revokes its own credential (Reset hub). Idempotent; phones' tokens are refused (403). */
export const POST = route({ access: "hub" }, async ({ ctx, device }) => {
  await revokeSelf(ctx, device.id);
  return json({ revoked: true });
});
