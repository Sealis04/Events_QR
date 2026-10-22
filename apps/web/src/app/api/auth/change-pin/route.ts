import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { changePin } from "../../../../server/pins";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "staff" }, body: api.changePinRequest, allowPinReset: true },
  async ({ ctx, staff, body }) => {
    await changePin(ctx, staff, body.current_pin, body.new_pin);
    return json({ ok: true });
  },
);
