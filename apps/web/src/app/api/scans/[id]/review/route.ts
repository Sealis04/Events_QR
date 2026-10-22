import { api } from "@events-qr/core";
import { reviewConflict } from "../../../../../server/dashboard";
import { json, route } from "../../../../../server/http";

export const dynamic = "force-dynamic";

/** VM only: the hub's conflict feed is read-only. */
export const POST = route(
  { access: { staff: "supervisor" }, body: api.reviewConflictRequest },
  async ({ ctx, staff, params, body }) => {
    await reviewConflict(ctx, staff, params.id!, body.reviewed);
    return json({ ok: true });
  },
);
