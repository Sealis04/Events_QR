import { api } from "@events-qr/core";
import { listAuditLog } from "../../../../server/audit";
import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const GET = route(
  { access: { staff: "admin" }, query: api.staffLogQuery },
  async ({ ctx, query }) => json(await listAuditLog(ctx, query.before)),
);
