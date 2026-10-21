import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "staff" } }, async ({ staff }) => json(staff));
