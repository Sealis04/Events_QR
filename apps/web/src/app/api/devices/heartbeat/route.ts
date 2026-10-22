import { api } from "@events-qr/core";
import { recordHeartbeat } from "../../../../server/deviceAdmin";
import { json, route } from "../../../../server/http";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

const vmHeartbeat = route(
  { access: "device", body: api.heartbeatRequest },
  async ({ ctx, device, body }) => {
    await recordHeartbeat(ctx, device.id, body);
    return json({ ok: true });
  },
);

export const POST = byMode(
  vmHeartbeat,
  async () => (await import("../../../../hub/dashboard")).heartbeat,
);
