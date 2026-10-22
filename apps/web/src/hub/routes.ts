/**
 * Route handlers for `APP_MODE=hub`. The route files in `src/app/api` pick these when the process
 * runs as a hub; shapes match the VM's so the scanner client does not change.
 */
import { sql } from "drizzle-orm";
import { api, sqliteSchema } from "@events-qr/core";
import { loginIpLimiter, loginLimiter, verifyPin } from "../server/auth";
import { HttpError, json } from "../server/errors";
import { claimTicket, exitTicket } from "./claim";
import { exchangeHubEnrolment } from "./enroll";
import { hubRoute } from "./http";
import { uploadScans } from "./scans";
import { getState } from "./state";
import { syncForDevice } from "./sync";
import { pendingScanCount } from "./vmsync";

const { staff } = sqliteSchema;

export const claim = hubRoute(
  { access: "device", body: api.claimRequest },
  ({ ctx, device, body }) => claimTicket(ctx, device, body).then((r) => json(r)),
);

export const exit = hubRoute({ access: "device", body: api.exitRequest }, ({ ctx, device, body }) =>
  exitTicket(ctx, device, body).then((r) => json(r)),
);

export const sync = hubRoute(
  { access: "device", query: api.hubSyncQuery },
  ({ ctx, device, query }) => json(syncForDevice(ctx, device, query)),
);

export const scans = hubRoute(
  { access: "device", body: api.hubScansRequest },
  ({ ctx, device, body }) => json(uploadScans(ctx, device, body)),
);

/** `POST /api/enroll` and `POST /api/devices/enroll` (exchange step): offline from cached codes. */
export const enroll = hubRoute(
  { access: "public", body: api.enrollExchangeRequest },
  ({ ctx, body }) => json(exchangeHubEnrolment(ctx, body)),
);

export const health = hubRoute({ access: "public" }, ({ ctx }) => {
  const last = getState(ctx, "last_cloud_sync_at");
  return json({
    ok: true,
    mode: "hub",
    last_cloud_sync_at: last ? Number(last) : null,
    pending_scans: pendingScanCount(ctx),
  });
});

/**
 * Staff PIN login for phones, against the staff mirrored from the VM. Only the answer is used (the
 * phone authenticates with its device token), so no session cookie is set.
 */
export const login = hubRoute(
  { access: "public", body: api.loginRequest },
  async ({ req, ctx, body }) => {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const key = `${ip}|${body.name.toLowerCase()}`;
    const now = ctx.now();
    if (loginLimiter.blocked(key, now) || loginIpLimiter.blocked(ip, now)) {
      throw new HttpError(429, "too_many_attempts", "too many failed logins; wait a minute");
    }
    const row = ctx.db
      .select()
      .from(staff)
      .where(sql`lower(${staff.name}) = ${body.name.toLowerCase()}`)
      .get();
    if (!(await verifyPin(body.pin, row?.pinHash)) || !row) {
      loginLimiter.fail(key, now);
      loginIpLimiter.fail(ip, now);
      throw new HttpError(401, "invalid_credentials", "wrong name or PIN");
    }
    loginLimiter.reset(key);
    return json({ id: row.id, name: row.name, role: row.role });
  },
);
