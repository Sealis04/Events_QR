/** Where an event stands: Live, In N days, Ended, or Setup not finished (no ticket types yet). */
export function eventStatus(
  ev: { starts_at: number; ends_at: number; ticket_type_count: number },
  now: number,
) {
  if (now > ev.ends_at) return { key: "ended", label: "ENDED", tone: "" } as const;
  if (ev.ticket_type_count === 0)
    return { key: "setup", label: "SETUP NOT FINISHED", tone: "warn" } as const;
  if (now >= ev.starts_at) return { key: "live", label: "LIVE", tone: "ok" } as const;
  const days = Math.ceil((ev.starts_at - now) / 86400);
  return {
    key: "soon",
    label: ev.starts_at - now < 86400 ? "TODAY" : `IN ${days} DAY${days === 1 ? "" : "S"}`,
    tone: "info",
  } as const;
}
