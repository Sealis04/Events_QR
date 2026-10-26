"use client";

import { useEffect, useState } from "react";

/** HH:MM in the event's time zone (24 h, no seconds). */
export function hhmm(unix: number, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: timezone,
    }).format(new Date(unix * 1000));
  } catch {
    return new Date(unix * 1000).toISOString().slice(11, 16);
  }
}

/** "6 Nov" style day for table cells. */
export function dayMonth(unix: number, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: timezone,
    }).format(new Date(unix * 1000));
  } catch {
    return new Date(unix * 1000).toISOString().slice(5, 10);
  }
}

/** True on phone-width screens (matches the 640 px breakpoint in dashboard.css). */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return phone;
}
