import { exportTicketsCsv } from "../../../../../../server/csv";
import { intParam, route } from "../../../../../../server/http";

export const dynamic = "force-dynamic";

export const GET = route({ access: { staff: "admin" } }, async ({ ctx, params }) => {
  const id = intParam(params, "id");
  return new Response(await exportTicketsCsv(ctx, id), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="event-${id}-tickets.csv"`,
      "cache-control": "no-store",
    },
  });
});
