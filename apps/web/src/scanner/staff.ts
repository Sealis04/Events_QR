import { ApiRejected, NetworkError } from "./client";
import { cloudBase, hubBase } from "./routes";
import type { DeviceRecord, StaffSession } from "./types";

/**
 * Staff PIN login. Only the answer is used: the session cookie the server sets is not (the phone
 * authenticates with its device token), so the request is sent without credentials.
 */
export async function loginStaff(
  baseUrl: string,
  name: string,
  pin: string,
  doFetch: typeof fetch = fetch,
  timeoutMs = 8000,
): Promise<StaffSession> {
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, pin }),
      credentials: "omit",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new NetworkError("Could not reach the server");
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new ApiRejected(
      res.status,
      data?.error?.code ?? "error",
      data?.error?.message ?? "Login failed",
    );
  }
  return { id: data.id, name: data.name, role: data.role };
}

/**
 * Login at the hub, then the VM. The hub has the staff list (mirrored from the VM) and answers
 * with no internet; its PIN check can be slow on a Pi, so it gets more than the 800 ms a claim
 * does. If the hub is down, or does not know the name or PIN (a staff member added a moment ago),
 * the VM gets a say. Too many attempts stops at once.
 */
export async function loginStaffRouted(
  device: DeviceRecord,
  name: string,
  pin: string,
  doFetch: typeof fetch = fetch,
): Promise<StaffSession> {
  const servers = [hubBase(device), cloudBase(device)].filter((u): u is string => u !== null);
  let refused: ApiRejected | undefined;
  let lastError: unknown;
  for (const server of servers) {
    try {
      return await loginStaff(server, name, pin, doFetch, 5000);
    } catch (err) {
      lastError = err;
      if (err instanceof ApiRejected) {
        if (err.status !== 401) throw err;
        refused ??= err;
      }
    }
  }
  throw refused ?? lastError ?? new NetworkError("Could not reach the server");
}

export const isSupervisor = (s: StaffSession): boolean =>
  s.role === "supervisor" || s.role === "admin";
