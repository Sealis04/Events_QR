/**
 * "Today: N in · M out" on the gate phone: counted from this phone's own scans (never the whole
 * event), kept in the encrypted store so a reload keeps it and no network is needed. "Today" is
 * the event-local day (24 h steps from `day_zero`, like the login cut-off in session.ts).
 */
import type { DeviceRecord, ScannerStore } from "./types";

const KEY = "today-counts";

export interface TodayCounts {
  day: number;
  in: number;
  out: number;
}

const dayOf = (device: DeviceRecord, now: number) =>
  Math.floor((now - device.bundle.day_zero) / 86400);

export async function readCounts(
  store: ScannerStore,
  device: DeviceRecord,
  now: number,
): Promise<TodayCounts> {
  const saved = await store.getMeta<TodayCounts>(KEY).catch(() => undefined);
  const day = dayOf(device, now);
  return saved && saved.day === day ? saved : { day, in: 0, out: 0 };
}

export async function bumpCount(
  store: ScannerStore,
  device: DeviceRecord,
  kind: "in" | "out",
  now: number,
): Promise<TodayCounts> {
  const counts = await readCounts(store, device, now);
  const next = { ...counts, [kind]: counts[kind] + 1 };
  await store.setMeta(KEY, next);
  return next;
}
