import { ApiRejected, NetworkError } from "./client";
import type { StaffSession } from "./types";

/**
 * Staff PIN login. Only the answer is used: the session cookie the server sets is not (the phone
 * authenticates with its device token), so the request is sent without credentials.
 */
export async function loginStaff(
  baseUrl: string,
  name: string,
  pin: string,
  doFetch: typeof fetch = fetch,
): Promise<StaffSession> {
  let res: Response;
  try {
    res = await doFetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, pin }),
      credentials: "omit",
      signal: AbortSignal.timeout(8000),
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

export const isSupervisor = (s: StaffSession): boolean =>
  s.role === "supervisor" || s.role === "admin";
