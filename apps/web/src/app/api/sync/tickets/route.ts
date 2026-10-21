import { api } from "@events-qr/core";
import { json, route } from "../../../../server/http";
import { syncTickets } from "../../../../server/sync";

export const dynamic = "force-dynamic";

export const GET = route(
  { access: "device", query: api.syncTicketsQuery },
  async ({ ctx, device, query }) => json(await syncTickets(ctx, device, query)),
);
