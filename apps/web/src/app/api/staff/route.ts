import { api } from "@events-qr/core";
import { json, route } from "../../../server/http";
import { createStaff } from "../../../server/staff";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: { staff: "admin" }, body: api.createStaffRequest },
  async ({ ctx, body }) => json(await createStaff(ctx, body), 201),
);
