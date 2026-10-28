import { api } from "@events-qr/core";
import { json, route } from "../../../server/http";
import { createStaff, listStaff } from "../../../server/staff";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "admin" } }, async ({ ctx }) =>
  json(await listStaff(ctx)),
);

export const POST = route(
  { access: { staff: "admin" }, body: api.createStaffRequest },
  async ({ ctx, staff, body }) => json(await createStaff(ctx, body, staff.id), 201),
);
