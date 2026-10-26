/**
 * The staff login on the phone. It lives in the encrypted store (meta, sealed like every other
 * secret, deleted by `store.wipe()`), so it survives a reload, closing the app and a browser
 * restart, online or offline. It ends at the first of:
 *
 *   - sign out / switch staff member (`clearSession`)
 *   - the next 05:00 event-local time after the login (a night shift is not cut at midnight)
 *   - the end of the event
 *   - revoke, "Set up again" and the end-of-event wipe (they all call `store.wipe()`)
 *
 * There is no idle timeout. Times are Unix seconds on the server's clock (`device.clockOffset`
 * corrects the phone's). The bundle has no time zone, but `day_zero` is 00:00 local on the event's
 * first day and event days are 24 h (spec: no DST handling), so 05:00 on day k is
 * `day_zero + k * 86400 + 5 * 3600`.
 */
import type { DeviceRecord, ScannerStore, StaffSession } from "./types";

const KEY = "staff-session";
const DAY = 86400;
/** Local hour at which a login stops being valid. */
export const CUTOFF_HOUR = 5;

interface Saved {
  staff: StaffSession;
  expiresAt: number;
  deviceId: string;
}

/** The first 05:00 event-local strictly after `loginAt`, capped at the event end. */
export function sessionExpiry(loginAt: number, dayZero: number, eventEndsAt: number): number {
  const offset = CUTOFF_HOUR * 3600;
  const k = Math.floor((loginAt - dayZero - offset) / DAY) + 1;
  return Math.min(dayZero + offset + k * DAY, eventEndsAt);
}

/** Server-clock seconds on this phone. */
export const serverNow = (device: DeviceRecord, localNow = Date.now()): number =>
  Math.floor(localNow / 1000) + device.clockOffset;

export async function saveSession(
  store: ScannerStore,
  device: DeviceRecord,
  staff: StaffSession,
  now: number = serverNow(device),
): Promise<void> {
  const saved: Saved = {
    staff,
    deviceId: device.deviceId,
    expiresAt: sessionExpiry(now, device.bundle.day_zero, device.bundle.ends_at),
  };
  await store.setMeta(KEY, saved);
}

/** The saved login if it is still valid for this device; an expired or foreign one is deleted. */
export async function loadSession(
  store: ScannerStore,
  device: DeviceRecord,
  now: number = serverNow(device),
): Promise<StaffSession | null> {
  const saved = await store.getMeta<Saved>(KEY).catch(() => undefined);
  if (!saved) return null;
  if (saved.deviceId !== device.deviceId || now >= saved.expiresAt || device.ended) {
    await clearSession(store);
    return null;
  }
  return saved.staff;
}

/** Seconds until the saved login ends, or null when there is none. Drives the in-app expiry check. */
export async function sessionExpiresAt(store: ScannerStore): Promise<number | null> {
  return (await store.getMeta<Saved>(KEY).catch(() => undefined))?.expiresAt ?? null;
}

export async function clearSession(store: ScannerStore): Promise<void> {
  await store.setMeta(KEY, null);
}
