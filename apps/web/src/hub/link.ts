/**
 * Binds a hub to one event: exchanges the setup code (made on the VM by a supervisor) for the
 * hub's credential and the key bundle, and stores them in `hub_state`. The bundle holds the event
 * AES key and the public signing keys; the Ed25519 secret never leaves the VM. Run by
 * `scripts/hub-enroll.ts`.
 */
import { randomUUID } from "node:crypto";
import { api } from "@events-qr/core";
import type { HubContext } from "./context";
import { setState } from "./state";
import { pullMeta, vmClientFor } from "./vmsync";
import { VmRefused, VmUnreachable } from "./vmclient";

export async function linkHubToVm(
  ctx: HubContext,
  options: { vmUrl: string; code: string },
): Promise<{ eventId: number }> {
  const vmUrl = options.vmUrl.replace(/\/+$/, "");
  const deviceId = randomUUID();
  let res: Response;
  try {
    res = await (ctx.vmFetch ?? fetch)(`${vmUrl}/api/hubs/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: options.code, device_id: deviceId }),
      signal: AbortSignal.timeout(ctx.config.HUB_VM_TIMEOUT_SECONDS * 1000),
    });
  } catch (err) {
    throw new VmUnreachable(err instanceof Error ? err.message : "network error");
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok) throw new VmRefused(res.status, data?.error?.message ?? `VM answered ${res.status}`);
  const parsed = api.enrollExchangeResponse.parse(data);

  setState(ctx, "vm_url", vmUrl);
  setState(ctx, "hub_device_id", parsed.device_id);
  setState(ctx, "hub_token", parsed.device_token);
  setState(ctx, "bundle", JSON.stringify({ ...parsed.key_bundle, cloud_url: vmUrl }));
  // A new binding starts from scratch.
  setState(ctx, "cursor_tickets", null);
  setState(ctx, "cursor_scans", null);
  await pullMeta(ctx, vmClientFor(ctx)!);
  return { eventId: parsed.key_bundle.event_id };
}
