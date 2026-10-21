/** True when `tz` is an IANA zone this runtime knows. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Unix seconds of 00:00 local time (in `tz`) on the day containing `unix`: the origin of the
 * slot minutes in tickets. Handles zones whose offset changes during that day.
 */
export function localDayZero(unix: number, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  /** The wall clock in `tz` at `t`, expressed as if it were UTC. */
  const wall = (t: number): number => {
    const o: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(t * 1000))) o[p.type] = p.value;
    return Date.UTC(+o.year!, +o.month! - 1, +o.day!, +o.hour!, +o.minute!, +o.second!) / 1000;
  };
  const dayStart = Math.floor(wall(unix) / 86400) * 86400;
  let guess = dayStart - (wall(unix) - unix);
  guess -= wall(guess) - dayStart;
  return guess;
}
