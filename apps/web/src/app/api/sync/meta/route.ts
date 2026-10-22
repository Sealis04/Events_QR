import { json, route } from "../../../../server/http";
import { syncMeta } from "../../../../server/sync";

export const dynamic = "force-dynamic";

export const GET = route({ access: "hub" }, async ({ ctx, device }) =>
  json(await syncMeta(ctx, device)),
);
