import { eq } from "drizzle-orm";
import { sqliteSchema, type api } from "@events-qr/core";
import type { z } from "zod";
import type { HubContext } from "./context";

const { hubState } = sqliteSchema;

/** Keys of the `hub_state` table. */
export type StateKey =
  | "vm_url" // base URL of the VM
  | "hub_device_id"
  | "hub_token" // the hub's bearer credential at the VM
  | "event_id"
  | "bundle" // JSON key bundle: event key + public keys (never a signing secret)
  | "cursor_tickets" // `<updated_at>:<id>` on the VM
  | "cursor_scans" // `<received_at>:<id>` on the VM
  | "last_cloud_sync_at"
  | "last_cloud_error"
  | "last_pull_at" // last fully successful VM -> hub pull (unix seconds)
  | "pull_request" // "Pull tickets now": id set by the web app, polled by the worker (hub/pullnow.ts)
  | "pull_requested_at" // when the last request was accepted (rate limit)
  | "pull_handled" // id of the last request the worker answered
  | "pull_result" // JSON `PullNowResult` of that request
  | "session_secret" // HMAC key for dashboard sessions on this hub
  | "cloud_down_since" // unix seconds of the first failed sync of the current outage (hub setup, step 8)
  | "cloud_last_ok_at" // last sync call that reached the VM
  | "cloud_outages" // JSON `Outage[]`: the last finished outages
  | "offline_test_started_at"; // when "Start the offline test" was pressed

export function getState(ctx: Pick<HubContext, "db">, key: StateKey): string | undefined {
  return ctx.db.select().from(hubState).where(eq(hubState.key, key)).get()?.value;
}

export function setState(ctx: Pick<HubContext, "db">, key: StateKey, value: string | null): void {
  if (value === null) {
    ctx.db.delete(hubState).where(eq(hubState.key, key)).run();
    return;
  }
  ctx.db
    .insert(hubState)
    .values({ key, value })
    .onConflictDoUpdate({ target: hubState.key, set: { value } })
    .run();
}

export type KeyBundle = z.infer<typeof api.keyBundle>;

export const getBundle = (ctx: Pick<HubContext, "db">): KeyBundle | undefined => {
  const raw = getState(ctx, "bundle");
  return raw ? (JSON.parse(raw) as KeyBundle) : undefined;
};

export interface HubLink {
  vmUrl: string;
  token: string;
  deviceId: string;
}

/** The hub's credential at the VM, or undefined while the hub is not enrolled. */
export function getLink(ctx: Pick<HubContext, "db">): HubLink | undefined {
  const vmUrl = getState(ctx, "vm_url");
  const token = getState(ctx, "hub_token");
  const deviceId = getState(ctx, "hub_device_id");
  return vmUrl && token && deviceId ? { vmUrl, token, deviceId } : undefined;
}

export const getEventId = (ctx: Pick<HubContext, "db">): number | undefined => {
  const raw = getState(ctx, "event_id");
  return raw ? Number(raw) : undefined;
};
