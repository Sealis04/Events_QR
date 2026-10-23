/**
 * "Pull tickets now" on the hub dashboard. The web process must not hold the VM credentials or
 * run the sync itself, so it only leaves a request in `hub_state`; the sync worker (which already
 * owns the VM link) polls for it every second, runs one pull pass and writes the answer back,
 * and the web request returns that answer.
 *
 *   web:    requestPull()          rate limit (10 s) -> write `pull_request` -> wait for `pull_result`
 *   worker: servePullRequest()     `pull_request` != `pull_handled` -> pullCycle -> `pull_result`
 */
import { randomUUID } from "node:crypto";
import type { HubContext } from "./context";
import { immediate } from "./context";
import { getState, setState } from "./state";
import { VmRefused, VmUnreachable } from "./vmclient";
import { pullCycle, vmClientFor } from "./vmsync";

export const PULL_NOW_MIN_INTERVAL_SECONDS = 10;
/** How long the web request waits for the worker. A pass that needs longer is reported as "no answer". */
export const PULL_NOW_WAIT_MS = 20_000;

export interface PullNowResult {
  request: string;
  ok: boolean;
  /** Tickets and VM scans that changed on the hub. */
  changes: number;
  tickets: number;
  scans: number;
  /** "vm_unreachable" | "vm_refused" | "not_linked" (set when `ok` is false) */
  error?: string;
  message?: string;
  /** Unix seconds of the last fully successful pull, or null if there never was one. */
  last_pull_at: number | null;
}

export class PullRateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super(`Pulled a moment ago. Try again in ${retryAfter} s.`);
  }
}

const lastPullAt = (ctx: HubContext): number | null => {
  const raw = getState(ctx, "last_pull_at");
  return raw ? Number(raw) : null;
};

/** Worker side: answer an open request, if any. Returns true when it ran one. */
export async function servePullRequest(ctx: HubContext): Promise<boolean> {
  const request = getState(ctx, "pull_request");
  if (!request || request === getState(ctx, "pull_handled")) return false;
  const result: PullNowResult = {
    request,
    ok: false,
    changes: 0,
    tickets: 0,
    scans: 0,
    last_pull_at: null,
  };
  const vm = vmClientFor(ctx);
  if (!vm) {
    result.error = "not_linked";
    result.message = "This hub is not linked to a VM yet.";
  } else {
    try {
      const pulled = await pullCycle(ctx, vm);
      result.ok = true;
      result.tickets = pulled.tickets;
      result.scans = pulled.scans;
      result.changes = pulled.tickets + pulled.scans;
    } catch (err) {
      result.error = err instanceof VmRefused ? "vm_refused" : "vm_unreachable";
      result.message =
        err instanceof VmUnreachable || err instanceof VmRefused ? err.message : "The pull failed.";
      if (!(err instanceof VmUnreachable || err instanceof VmRefused)) console.error(err);
    }
  }
  result.last_pull_at = lastPullAt(ctx);
  setState(ctx, "pull_result", JSON.stringify(result));
  setState(ctx, "pull_handled", request);
  return true;
}

/** Web side. Throws `PullRateLimited`; resolves to the worker's answer, or `no_answer` if it never comes. */
export async function requestPull(
  ctx: HubContext,
  options: { waitMs?: number; pollMs?: number } = {},
): Promise<PullNowResult> {
  const id = randomUUID();
  immediate(ctx, () => {
    const now = ctx.now();
    const last = Number(getState(ctx, "pull_requested_at") ?? 0);
    const wait = PULL_NOW_MIN_INTERVAL_SECONDS - (now - last);
    if (wait > 0) throw new PullRateLimited(wait);
    setState(ctx, "pull_requested_at", String(now));
    setState(ctx, "pull_request", id);
  });
  const deadline = Date.now() + (options.waitMs ?? PULL_NOW_WAIT_MS);
  const pollMs = options.pollMs ?? 200;
  while (Date.now() < deadline) {
    const raw = getState(ctx, "pull_result");
    if (raw) {
      const result = JSON.parse(raw) as PullNowResult;
      if (result.request === id) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return {
    request: id,
    ok: false,
    changes: 0,
    tickets: 0,
    scans: 0,
    error: "no_answer",
    message: "The sync worker did not answer. Is it running?",
    last_pull_at: lastPullAt(ctx),
  };
}
