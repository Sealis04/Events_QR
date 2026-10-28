import { eq } from "drizzle-orm";
import { api, mysqlSchema } from "@events-qr/core";
import {
  createSessionValue,
  loginIpLimiter,
  loginLimiter,
  sessionCookie,
  verifyPin,
} from "../../../../server/auth";
import { HttpError, json, pinChangeRequired, route } from "../../../../server/http";
import { settleLogin } from "../../../../server/pins";
import { byMode } from "../../../../server/mode";

export const dynamic = "force-dynamic";

const vmLogin = route({ access: "public", body: api.loginRequest }, async ({ req, ctx, body }) => {
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
  // A deactivated account is refused exactly like a wrong PIN.
  const active = row && row.deactivatedAt === null ? row : undefined;
  if (!(await verifyPin(body.pin, active?.pinHash)) || !active) {
    loginLimiter.fail(key, now);
    loginIpLimiter.fail(ip, now);
    throw new HttpError(401, "invalid_credentials", "wrong name or PIN");
  }
  loginLimiter.reset(key);
  const pinReset = await settleLogin(ctx, active, body.pin);
  // A phone gets no restricted session: it has to wait until the PIN is changed on the dashboard.
  if (pinReset && body.for === "scanner") throw pinChangeRequired();
  return json({ id: active.id, name: active.name, role: active.role, pin_reset: pinReset }, 200, {
    "set-cookie": sessionCookie(ctx, createSessionValue(ctx, active.id)),
  });
});

export const POST = byMode(vmLogin, async () => (await import("../../../../hub/dashboard")).login);
