import type { z } from "zod";
import { api } from "@events-qr/core";

/** The VM could not be reached in time (offline, DNS, timeout, 5xx). Retried with backoff. */
export class VmUnreachable extends Error {}
/** The VM answered but refused (revoked hub, bad request). Not fixed by retrying quickly. */
export class VmRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface VmClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** The hub's calls to the VM's `/api/sync/*`, authenticated with the hub's own device token. */
export class VmClient {
  constructor(private readonly options: VmClientOptions) {}

  private async request<S extends z.ZodTypeAny>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    let res: Response;
    try {
      res = await (this.options.fetch ?? fetch)(this.options.baseUrl.replace(/\/+$/, "") + path, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new VmUnreachable(err instanceof Error ? err.message : "network error");
    }
    if (res.status >= 500) throw new VmUnreachable(`VM error ${res.status}`);
    const data = await res.json().catch(() => undefined);
    if (!res.ok)
      throw new VmRefused(res.status, data?.error?.message ?? `VM answered ${res.status}`);
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new VmRefused(res.status, "unexpected answer from the VM");
    return parsed.data;
  }

  meta = () => this.request("GET", "/api/sync/meta", api.syncMetaResponse);

  tickets = (cursor: string | null, limit = 500) =>
    this.request(
      "GET",
      `/api/sync/tickets?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      api.syncTicketsResponse,
    );

  scans = (cursor: string | null, limit = 500) =>
    this.request(
      "GET",
      `/api/sync/scans?limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`,
      api.syncVmScansResponse,
    );

  pushScans = (scans: z.infer<typeof api.syncScansRequest>["scans"]) =>
    this.request("POST", "/api/sync/scans", api.syncScansResponse, { scans });

  pushChecks = (checks: z.infer<typeof api.syncHubChecksRequest>["checks"]) =>
    this.request("POST", "/api/sync/hub-checks", api.syncHubChecksResponse, { checks });

  counts = () => this.request("GET", "/api/sync/counts", api.syncCountsResponse);

  pushDevices = (devices: z.infer<typeof api.syncDevicesRequest>["devices"]) =>
    this.request("POST", "/api/sync/devices", api.syncDevicesResponse, { devices });
}
