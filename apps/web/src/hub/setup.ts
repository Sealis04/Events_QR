/**
 * The hub's own setup page backend: what `/setup` and the reset dialog may know (`hubStatus`) and
 * the link from the browser (`linkFromWeb`). Same steps as `scripts/hub-enroll.ts`, but the server
 * address always comes from `HUB_SERVER_URL`, never from the request, so nobody on the venue LAN can
 * point the hub at another server.
 */
import { isNull, sql } from "drizzle-orm";
import { sqliteSchema, type api } from "@events-qr/core";
import type { z } from "zod";
import { HttpError } from "../server/errors";
import type { HubContext } from "./context";
import { linkHubToVm } from "./link";
import { getLink } from "./state";
import { VmRefused, VmUnreachable } from "./vmclient";
import { pullCycle, pushCycle, vmClientFor } from "./vmsync";

const { events, hubScanOutbox, hubDeviceOutbox, hubCheckOutbox } = sqliteSchema;

export type HubUnsent = z.infer<typeof api.hubUnsent>;

/** Records the hub holds that the server has not acknowledged; a reset would lose them. */
export function unsentCounts(ctx: Pick<HubContext, "db">): HubUnsent {
  const n = (t: typeof hubScanOutbox | typeof hubDeviceOutbox | typeof hubCheckOutbox) =>
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(t)
      .where(isNull(t.ackedAt))
      .get()?.n ?? 0;
  return { scans: n(hubScanOutbox), devices: n(hubDeviceOutbox), checks: n(hubCheckOutbox) };
}

export function hubStatus(ctx: HubContext): z.infer<typeof api.hubStatusResponse> {
  const linked = !!getLink(ctx);
  const event = linked ? ctx.db.select().from(events).limit(1).get() : undefined;
  return {
    linked,
    server_url: ctx.config.HUB_SERVER_URL?.replace(/\/+$/, "") ?? null,
    event_id: event?.id ?? null,
    event_name: event?.name ?? null,
    unsent: unsentCounts(ctx),
  };
}

const PER_CLIENT = 5;
const GLOBAL = 30;
const WINDOW_SECONDS = 60;
const GLOBAL_WINDOW_SECONDS = 600;
const tries = new Map<string, number[]>();
let allTries: number[] = [];
let inFlight = false;

/** Test hook: forget earlier attempts. */
export function resetLinkLimits(): void {
  tries.clear();
  allTries = [];
  inFlight = false;
}

/** 5 tries a minute per client and 30 per ten minutes overall; the code is guessable only by trying. */
function takeAttempt(ctx: HubContext, client: string): void {
  const now = ctx.now();
  allTries = allTries.filter((t) => now - t < GLOBAL_WINDOW_SECONDS);
  const mine = (tries.get(client) ?? []).filter((t) => now - t < WINDOW_SECONDS);
  if (mine.length >= PER_CLIENT || allTries.length >= GLOBAL) {
    tries.set(client, mine);
    throw new HttpError(429, "rate_limited", "Too many tries. Wait a minute, then try again.", {
      retry_after: WINDOW_SECONDS,
    });
  }
  mine.push(now);
  tries.set(client, mine);
  allTries.push(now);
}

/** Links the hub with a setup code, then runs the first full pull and push. Throws `HttpError` with plain messages. */
export async function linkFromWeb(
  ctx: HubContext,
  code: string,
  client: string,
): Promise<z.infer<typeof api.hubLinkResponse>> {
  if (getLink(ctx))
    throw new HttpError(409, "already_linked", "This hub is already linked. Reset it first.");
  const vmUrl = ctx.config.HUB_SERVER_URL;
  if (!vmUrl)
    throw new HttpError(
      503,
      "no_server_url",
      "This hub has no server address. Set HUB_SERVER_URL in its .env and restart it.",
    );
  takeAttempt(ctx, client);
  if (inFlight)
    throw new HttpError(409, "link_in_progress", "Another setup is running. Wait a moment.");
  inFlight = true;
  try {
    let eventId: number | undefined;
    try {
      eventId = (await linkHubToVm(ctx, { vmUrl, code })).eventId;
    } catch (err) {
      // The code worked and the credential is stored; only the first pull failed. The worker retries it.
      if (!getLink(ctx)) throw err;
    }
    let tickets = 0;
    const vm = vmClientFor(ctx)!;
    try {
      tickets = (await pullCycle(ctx, vm)).tickets;
      await pushCycle(ctx, vm);
    } catch {
      // Unreachable for a moment: the sync loops continue from here.
    }
    const event = ctx.db.select().from(events).limit(1).get();
    return { event_id: event?.id ?? eventId ?? 0, event_name: event?.name ?? null, tickets };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof VmRefused)
      throw new HttpError(
        400,
        "code_refused",
        "That code was not accepted. It may have been used already or expired (codes last 10 minutes and work once). Make a new one on the server.",
      );
    if (err instanceof VmUnreachable)
      throw new HttpError(
        502,
        "server_unreachable",
        "Cannot reach the server. Check this machine's internet connection and its clock, then try again.",
      );
    throw err;
  } finally {
    inFlight = false;
  }
}

export const isLinked = (ctx: Pick<HubContext, "db">): boolean => !!getLink(ctx);
