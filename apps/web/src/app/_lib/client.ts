"use client";

/** Tiny fetch helper for the dashboard pages. Sends the session cookie, throws on API errors. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new ApiError(
      res.status,
      data?.error?.message ?? res.statusText,
      data?.error?.code,
      data?.error?.details,
    );
  return data as T;
}

/** Date and time in the viewer's zone, no seconds ("6 Nov, 18:00"). */
export const formatTime = (unix: number): string =>
  new Date(unix * 1000).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
export const formatClock = (unix: number): string =>
  new Date(unix * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Wall clock of `unix` in `tz`, as numbers. */
function wallParts(unix: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(unix * 1000)))
    if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number };
}

/** The wall clock in `tz` at `unix`, written as if it were UTC (seconds): lets zone maths be plain subtraction. */
export const wallSeconds = (unix: number, tz: string): number => {
  const w = wallParts(unix, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) / 1000;
};

/** Minutes east of UTC that `tz` is at `unix`. */
export const zoneOffsetMinutes = (tz: string, unix: number): number =>
  Math.round((wallSeconds(unix, tz) - Math.floor(unix / 60) * 60) / 60);

/** "UTC+8", "UTC-3:30". */
export function offsetLabel(tz: string, unix = Math.floor(Date.now() / 1000)): string {
  const m = zoneOffsetMinutes(tz, unix);
  const abs = Math.abs(m);
  return `UTC${m < 0 ? "-" : "+"}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

/** `datetime-local` value typed in zone `tz` -> Unix seconds. */
export function unixFromZoned(value: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return NaN;
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) / 1000;
  let guess = wall - zoneOffsetMinutes(tz, wall) * 60;
  guess = wall - zoneOffsetMinutes(tz, guess) * 60;
  return guess;
}
export function zonedFromUnix(unix: number, tz: string): string {
  const w = wallParts(unix, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}`;
}

/** Date text in the event's own zone: "Fri 6 Nov", "Fri 6 Nov, 18:00". */
export function eventDate(unix: number, tz: string, withTime = false): string {
  return new Date(unix * 1000).toLocaleString("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  });
}

/** The days an event covers, in its zone, as slot-day choices: index = days after the first day. */
export function eventDays(startsAt: number, endsAt: number, tz: string, atLeast = 1) {
  const first = Math.floor(wallSeconds(startsAt, tz) / 86400);
  const last = Math.floor(wallSeconds(Math.max(endsAt, startsAt), tz) / 86400);
  const count = Math.min(60, Math.max(atLeast, last - first + 1, 1));
  return Array.from({ length: count }, (_, i) => ({
    day: i,
    label: new Date((first + i) * 86400_000).toLocaleDateString("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    }),
  }));
}

/** "3 min ago" style age for the device panel. */
export function ago(unix: number | null, now: number): string {
  if (unix === null) return "never";
  const s = Math.max(0, now - unix);
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Minutes from 00:00 on the event's first day <-> "HH:MM" (hours may pass 24 for after-midnight slots). */
export const minutesToClock = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
export function clockToMinutes(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 0xfffe ? minutes : undefined;
}
export const SLOT_OPEN_END = 0xffff;

/** `datetime-local` value (in the browser's zone) <-> Unix seconds. */
export const unixFromLocal = (value: string): number =>
  Math.floor(new Date(value).getTime() / 1000);
export function localFromUnix(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
