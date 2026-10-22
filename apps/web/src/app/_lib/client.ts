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

export const formatTime = (unix: number): string => new Date(unix * 1000).toLocaleString();
export const formatClock = (unix: number): string =>
  new Date(unix * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

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
