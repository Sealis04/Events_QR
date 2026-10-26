/**
 * Route handlers for `APP_MODE=hub`. The route files in `src/app/api` pick these when the process
 * runs as a hub; shapes match the VM's so the scanner client does not change.
 */
import { api } from "@events-qr/core";
import { HttpError, json } from "../server/errors";
import { claimTicket, exitTicket } from "./claim";
import { exchangeHubEnrolment } from "./enroll";
import { hubRoute } from "./http";
import { PullRateLimited, requestPull } from "./pullnow";
import { uploadScans } from "./scans";
import { getState } from "./state";
import { syncForDevice } from "./sync";
import { pendingScanCount } from "./vmsync";

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
    ...(ctx.config.INSTANCE_LABEL ? { instance_label: ctx.config.INSTANCE_LABEL } : {}),
  });
});

/** Staff PIN login: phones get the answer only, supervisors and admins on the dashboard also a session. */
export { login } from "./dashboard";

/**
 * `POST /api/hub/pull` ("Pull tickets now"): asks the sync worker for one VM -> hub pass and
 * answers with what it did. An unreachable VM is a normal answer (`ok: false`), not an error.
 */
export const pullNow = hubRoute({ access: { staff: "supervisor" } }, async ({ ctx }) => {
  try {
    return json(await requestPull(ctx));
  } catch (err) {
    if (err instanceof PullRateLimited)
      throw new HttpError(429, "rate_limited", err.message, { retry_after: err.retryAfter });
    throw err;
  }
});
