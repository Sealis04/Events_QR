import { eq } from "drizzle-orm";
import { api, mysqlSchema } from "@events-qr/core";
import {
  createSessionValue,
  loginIpLimiter,
  loginLimiter,
  sessionCookie,
  verifyPin,
} from "../../../../server/auth";
import { HttpError, json, route } from "../../../../server/http";

export const dynamic = "force-dynamic";

export const POST = route(
  { access: "public", body: api.loginRequest },
  async ({ req, ctx, body }) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `${ip}|${body.name.toLowerCase()}`;
    const now = ctx.now();
    if (loginLimiter.blocked(key, now) || loginIpLimiter.blocked(ip, now)) {
      throw new HttpError(429, "too_many_attempts", "too many failed logins; wait a minute");
    }
    const [row] = await ctx.db
      .select()
      .from(mysqlSchema.staff)
      .where(eq(mysqlSchema.staff.name, body.name))
      .limit(1);
    if (!(await verifyPin(body.pin, row?.pinHash)) || !row) {
      loginLimiter.fail(key, now);
      loginIpLimiter.fail(ip, now);
      throw new HttpError(401, "invalid_credentials", "wrong name or PIN");
    }
    loginLimiter.reset(key);
    return json({ id: row.id, name: row.name, role: row.role }, 200, {
      "set-cookie": sessionCookie(ctx, createSessionValue(ctx, row.id)),
    });
  },
);
