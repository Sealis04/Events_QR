import { clearedSessionCookie } from "../../../../server/auth";
import { json, route } from "../../../../server/http";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

const vmLogout = route({ access: "public" }, async ({ ctx }) =>
  json({ ok: true }, 200, { "set-cookie": clearedSessionCookie(ctx) }),
);

export const POST = byMode(
  vmLogout,
  async () => (await import("../../../../hub/dashboard")).logout,
);
