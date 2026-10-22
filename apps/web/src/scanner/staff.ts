import { argon2Verify } from "hash-wasm";
import { ApiRejected, NetworkError } from "./client";
import { cloudBase, hubBase } from "./routes";
import type { DeviceRecord, ScannerStore, StaffSession } from "./types";

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

export const MAX_PIN_FAILURES = 5;
const LOCK_BASE_SECONDS = 60;
const LOCK_MAX_SECONDS = 15 * 60;
const LOCKOUT_KEY = "pin-lockout";

interface Lockout {
  /** Wrong PINs since the last good one. */
  fails: number;
  /** Unix seconds; logins are refused until then. */
  until: number;
  /** How many times the phone has locked since the last good PIN (the wait doubles each time). */
  rounds: number;
}

/** A wrong PIN while offline, or too many of them: shown as the login error. */
export class OfflineLoginError extends Error {
  constructor(
    readonly reason: "wrong" | "locked" | "no_staff",
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/**
 * Offline staff login: the PIN is checked against the argon2id hashes the phone pulled during sync
 * (never the PIN itself). Five wrong tries lock the phone for a minute, doubling each time (up to
 * 15 minutes); the counter lives in the store, so reloading the page does not reset it.
 */
export async function loginStaffOffline(
  store: ScannerStore,
  device: DeviceRecord,
  name: string,
  pin: string,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
): Promise<StaffSession> {
  const list = device.staff ?? [];
  if (list.length === 0)
    throw new OfflineLoginError("no_staff", "No network, and this phone has no staff list yet.");
  const now = nowSeconds();
  const state = (await store.getMeta<Lockout>(LOCKOUT_KEY)) ?? { fails: 0, until: 0, rounds: 0 };
  if (state.until > now) {
    throw new OfflineLoginError(
      "locked",
      `Too many wrong PINs. Try again in ${state.until - now} s.`,
      state.until - now,
    );
  }
  const row = list.find((s) => s.name.toLowerCase() === name.trim().toLowerCase());
  // An unknown name pays for a verification too, so it takes as long as a wrong PIN.
  const ok = await argon2Verify({ password: pin, hash: row?.pinHash ?? DECOY_HASH }).catch(
    () => false,
  );
  if (!ok || !row) {
    const fails = state.fails + 1;
    if (fails >= MAX_PIN_FAILURES) {
      const wait = Math.min(LOCK_MAX_SECONDS, LOCK_BASE_SECONDS * 2 ** state.rounds);
      await store.setMeta(LOCKOUT_KEY, { fails: 0, until: now + wait, rounds: state.rounds + 1 });
      throw new OfflineLoginError("locked", `Too many wrong PINs. Try again in ${wait} s.`, wait);
    }
    await store.setMeta(LOCKOUT_KEY, { ...state, fails });
    throw new OfflineLoginError("wrong", "Wrong name or PIN (offline check).");
  }
  await store.setMeta(LOCKOUT_KEY, { fails: 0, until: 0, rounds: 0 });
  return { id: row.id, name: row.name, role: row.role };
}

/** The hash of nothing anyone knows; verified against when a name is unknown. */
const DECOY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$1IfJ61tLauRhwGauYyI5xw$ccDha2LZKtJDXbwd0fVXBTg7lnW2xionVdv9Bww0/fc";

/**
 * Login that works with no network: the servers first (hub, then VM), and when neither can be
 * reached, the phone's own staff list. A refusal from a server (wrong PIN, too many attempts) is
 * final; only an unreachable network falls back.
 */
export async function loginStaffAny(
  store: ScannerStore,
  device: DeviceRecord,
  name: string,
  pin: string,
  doFetch: typeof fetch = fetch,
): Promise<StaffSession> {
  try {
    return await loginStaffRouted(device, name, pin, doFetch);
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    return loginStaffOffline(store, device, name, pin);
  }
}

export const isSupervisor = (s: StaffSession): boolean =>
  s.role === "supervisor" || s.role === "admin";
