/** Slot minutes are counted from 00:00 local on the event's first day. */
export const SLOT_NONE = 0xffff;
export const MAX_SLOT_MINUTE = 0xfffe;

/**
 * Converts a moment (Unix seconds UTC) to slot minutes.
 * @param dayZeroUnix Unix seconds of 00:00 local time on the event's first day.
 */
export function unixToSlotMinute(unix: number, dayZeroUnix: number): number {
  const minutes = Math.floor((unix - dayZeroUnix) / 60);
  if (minutes < 0 || minutes > MAX_SLOT_MINUTE)
    throw new RangeError("moment outside the slot range");
  return minutes;
}

export function slotMinuteToUnix(minute: number, dayZeroUnix: number): number {
  if (!Number.isInteger(minute) || minute < 0 || minute > MAX_SLOT_MINUTE) {
    throw new RangeError("not a slot minute");
  }
  return dayZeroUnix + minute * 60;
}
