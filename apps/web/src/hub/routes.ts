/**
 * Route handlers for `APP_MODE=hub`. The route files in `src/app/api` pick these when the process
 * runs as a hub; shapes match the VM's so the scanner client does not change.
 */
import { api } from "@events-qr/core";
import { json } from "../server/errors";
import { claimTicket, exitTicket } from "./claim";
import { exchangeHubEnrolment } from "./enroll";
import { hubRoute } from "./http";
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
  });
});

/** Staff PIN login: phones get the answer only, supervisors and admins on the dashboard also a session. */
export { login } from "./dashboard";
