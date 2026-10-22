import { api } from "@events-qr/core";
import { setAssignment } from "../../../../../../server/eventStaff";
import { intParam, json, route } from "../../../../../../server/http";

export const dynamic = "force-dynamic";

export const PUT = route(
  { access: { staff: "admin" }, body: api.setEventStaffRequest },
  async ({ ctx, params, body }) => {
    await setAssignment(ctx, intParam(params, "id"), params.staffId!, body.assigned);
    return json({ ok: true });
  },
);
