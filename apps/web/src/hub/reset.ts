/**
 * Reset hub: after the event a supervisor wipes the hub back to the `/setup` page. First the hub
 * asks the server to revoke its own credential, then one SQLite transaction deletes all event data
 * and every `hub_state` key (the session secret too, so every session ends).
 */
import { sqliteSchema, type api } from "@events-qr/core";
import type { z } from "zod";
import type { AuthedStaff } from "../server/auth";
import { HttpError } from "../server/errors";
import { immediate, type HubContext } from "./context";
import { getLink } from "./state";
import { unsentCounts } from "./setup";

const s = sqliteSchema;

const REVOKE_TIMEOUT_MS = 5000;

/** Tells the server to revoke this hub's credential. A 401 means it no longer works there, which is the goal too. */
async function revokeOnServer(ctx: HubContext): Promise<boolean> {
  const link = getLink(ctx);
  if (!link) return true;
  try {
    const res = await (ctx.vmFetch ?? fetch)(
      `${link.vmUrl.replace(/\/+$/, "")}/api/hubs/revoke-self`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${link.token}` },
        cache: "no-store",
        signal: AbortSignal.timeout(
          Math.min(REVOKE_TIMEOUT_MS, ctx.config.HUB_VM_TIMEOUT_SECONDS * 1000),
        ),
      },
    );
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

/** Deletes everything the hub holds about an event, keys and sessions included. */
export function wipeHub(ctx: HubContext): void {
  immediate(ctx, () => {
    for (const table of [
      s.hubCheckOutbox,
      s.hubChecks,
      s.hubScanOutbox,
      s.hubDeviceOutbox,
      s.scans,
      s.emailQueue,
      s.enrolmentCodes,
      s.devices,
      s.tickets,
      s.eventStaff,
      s.ticketTypes,
      s.staff,
      s.events,
      s.hubState,
    ])
      ctx.db.delete(table).run();
  });
}

export async function resetHub(
  ctx: HubContext,
  who: Pick<AuthedStaff, "role">,
  options: { force?: boolean },
): Promise<z.infer<typeof api.hubResetResponse>> {
  const unsent = unsentCounts(ctx);
  const waiting = unsent.scans + unsent.devices + unsent.checks;
  if (waiting > 0) {
    if (!options.force)
      throw new HttpError(
        409,
        "unsent_records",
        "Some records have not reached the server yet. Let the hub sync first.",
        unsent,
      );
    if (who.role !== "admin")
      throw new HttpError(403, "forbidden", "only an admin can delete unsent records");
  }
  const revoked = await revokeOnServer(ctx);
  if (!revoked && !options.force)
    throw new HttpError(
      409,
      "server_unreachable",
      "Cannot reach the server to revoke this hub. Check the internet connection and try again.",
    );
  wipeHub(ctx);
  return {
    revoked_on_server: revoked,
    message: revoked
      ? "Hub reset. It is ready for a new setup code."
      : "Hub reset, but the server could not be reached. Revoke this hub there: event → Devices → the hub → Revoke.",
  };
}
