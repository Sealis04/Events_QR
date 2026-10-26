import { exportTicketsCsv } from "../../../../../../server/csv";
import { intParam, route } from "../../../../../../server/http";
import { ticketFilterQuery } from "../../../../../../server/ticketQuery";

export const dynamic = "force-dynamic";

/** Supervisors and admins; the same search, type, status and state filters as the list. */
export const GET = route(
  { access: { staff: "supervisor" }, query: ticketFilterQuery },
  async ({ ctx, params, query }) => {
    const id = intParam(params, "id");
    return new Response(await exportTicketsCsv(ctx, id, query), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="event-${id}-tickets.csv"`,
        "cache-control": "no-store",
      },
    });
  },
);
