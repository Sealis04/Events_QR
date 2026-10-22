/**
 * The hub's two sync loops, run by the worker (`APP_MODE=hub`, apps/worker/src/hubMain.ts):
 *
 *   pull  VM -> hub   every HUB_TICKET_PULL_SECONDS (30 s): meta, tickets, the VM's scans
 *   push  hub -> VM   every HUB_SCAN_PUSH_SECONDS (5 s): devices enrolled here, then scans
 *
 * Both retry forever. While the VM is unreachable each waits twice as long after every failure
 * (up to HUB_MAX_BACKOFF_SECONDS) and goes back to its normal pace after the first success. The
 * hub's API keeps serving claims throughout: nothing here holds a lock the claim path needs
 * longer than one short transaction. The phone side of the sync (hub to phone, every 10 s) is
 * the phone polling `GET /api/sync`.
 */
import type { HubContext } from "./context";
import { vmClientFor, pullCycle, pushCycle } from "./vmsync";

export interface HubLoops {
  stop(): Promise<void>;
}

export interface HubLoopOptions {
  log?: (message: string, detail?: unknown) => void;
  /** Sleep, injectable so tests need not wait. Resolves early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Delay before the next run: the normal interval, doubled per consecutive failure, capped. */
export function nextDelayMs(intervalMs: number, failures: number, maxBackoffMs: number): number {
  if (failures === 0) return intervalMs;
  return Math.min(maxBackoffMs, intervalMs * 2 ** failures);
}

export function startHubLoops(ctx: HubContext, options: HubLoopOptions = {}): HubLoops {
  const log = options.log ?? (() => undefined);
  const sleep = options.sleep ?? defaultSleep;
  const abort = new AbortController();
  const maxBackoff = ctx.config.HUB_MAX_BACKOFF_SECONDS * 1000;

  async function run(
    name: string,
    intervalMs: number,
    step: (vm: NonNullable<ReturnType<typeof vmClientFor>>) => Promise<unknown>,
  ): Promise<void> {
    let failures = 0;
    let wasDown = false;
    while (!abort.signal.aborted) {
      // Built per pass: a hub that gets linked while the worker runs starts syncing by itself.
      const vm = vmClientFor(ctx);
      if (vm) {
        try {
          const result = await step(vm);
          if (wasDown) log(`hub ${name}: the VM is back`);
          wasDown = false;
          failures = 0;
          if (result && typeof result === "object" && Object.values(result).some(Boolean))
            log(`hub ${name}`, result);
        } catch (err) {
          failures = Math.min(failures + 1, 10);
          if (!wasDown) log(`hub ${name}: ${err instanceof Error ? err.message : err}; retrying`);
          wasDown = true;
        }
      }
      await sleep(nextDelayMs(intervalMs, failures, maxBackoff), abort.signal);
    }
  }

  const running = [
    run("pull", ctx.config.HUB_TICKET_PULL_SECONDS * 1000, (vm) => pullCycle(ctx, vm)),
    run("push", ctx.config.HUB_SCAN_PUSH_SECONDS * 1000, (vm) => pushCycle(ctx, vm)),
  ];
  return {
    async stop() {
      abort.abort();
      await Promise.all(running);
    },
  };
}
