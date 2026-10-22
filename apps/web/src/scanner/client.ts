import type { z } from "zod";
import type { api } from "@events-qr/core";
import type {
  ClaimResponse,
  ExitResponse,
  ScanRecord,
  SyncResponse,
  UploadResponse,
} from "./types";

/** The server could not be reached in time (offline, DNS, timeout, 5xx). */
export class NetworkError extends Error {}
/** The device token was refused: revoked or unknown. The phone wipes itself. */
export class AuthError extends Error {}
export class ApiRejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type ClaimBody = z.infer<typeof api.claimRequest>;
export type ExitBody = z.infer<typeof api.exitRequest>;

/** The scanner-facing API. The server (M3) and the venue hub (M4) both serve it. */
export interface HubClient {
  claim(body: ClaimBody): Promise<ClaimResponse>;
  exit(body: ExitBody): Promise<ExitResponse>;
  sync(cursor: string | null): Promise<SyncResponse>;
  /** Uploads scans decided offline (the outbox). Idempotent on `scan_id`. */
  uploadScans(scans: ScanRecord[]): Promise<UploadResponse>;
  health(): Promise<void>;
  /** Tells the dashboard how this phone is doing. Optional: older fakes and servers may lack it. */
  heartbeat?(body: { outbox_size: number; battery_pct: number | null }): Promise<void>;
}

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Per-request timeout; claims must fail fast so a dead link is noticed. */
  timeoutMs?: number;
}

export class HttpClient implements HubClient {
  constructor(private readonly options: HttpClientOptions) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.options.baseUrl + path, {
        method,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : "network error");
    }
    if (res.status === 401) throw new AuthError("this device is no longer enrolled");
    if (res.status >= 500) throw new NetworkError(`server error ${res.status}`);
    const data = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new ApiRejected(
        res.status,
        data?.error?.code ?? "error",
        data?.error?.message ?? res.statusText,
      );
    }
    return data as T;
  }

  heartbeat = async (body: { outbox_size: number; battery_pct: number | null }) => {
    await this.request("POST", "/api/devices/heartbeat", body);
  };

  claim = (body: ClaimBody) => this.request<ClaimResponse>("POST", "/api/claim", body);
  exit = (body: ExitBody) => this.request<ExitResponse>("POST", "/api/exit", body);
  sync = (cursor: string | null) =>
    this.request<SyncResponse>("GET", `/api/sync${cursor ? `?cursor=${cursor}` : ""}`);
  uploadScans = (scans: ScanRecord[]) =>
    this.request<UploadResponse>("POST", "/api/scans", { scans });
  health = async () => {
    await this.request("GET", "/api/health");
  };
}
