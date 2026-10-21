import { clearedSessionCookie } from "../../../../server/auth";
import { json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route({ access: "public" }, async ({ ctx }) =>
  json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(ctx) }),
);
