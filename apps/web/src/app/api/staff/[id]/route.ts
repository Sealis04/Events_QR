import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { updateStaff } from "../../../../server/staff";

export const dynamic = "force-dynamic";

export const PATCH = route(
  { access: { staff: "admin" }, body: api.updateStaffRequest },
  async ({ ctx, staff, params, body }) => {
    await updateStaff(ctx, staff.id, params.id!, body);
    return json({ ok: true });
  },
);
