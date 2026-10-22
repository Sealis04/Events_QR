import { json, route } from "../../../../server/http";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

const vmMe = route({ access: { staff: "staff" }, allowPinReset: true }, async ({ staff }) =>
  json({
    id: staff.id,
    name: staff.name,
    role: staff.role,
    pin_reset: staff.pinReset,
    mode: "server",
  }),
);

export const GET = byMode(vmMe, async () => (await import("../../../../hub/dashboard")).me);
