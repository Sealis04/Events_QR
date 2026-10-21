export const ENTRY_MODES = ["single", "unlimited", "limited"] as const;
export type EntryMode = (typeof ENTRY_MODES)[number];

export interface EntryRule {
  mode: EntryMode;
  /** Max admits: 1 for single, null for unlimited, 2-63 for limited. Matches `tickets.max_admits`. */
  maxAdmits: number | null;
}

const MODE_TO_BITS: Record<EntryMode, number> = { single: 0, unlimited: 1, limited: 2 };

/** Top 2 bits = mode, low 6 bits = max admits (limited only, 2-63), else 0. */
export function encodeEntryRule(mode: EntryMode, maxAdmits?: number | null): number {
  if (mode === "limited") {
    if (maxAdmits == null || !Number.isInteger(maxAdmits) || maxAdmits < 2 || maxAdmits > 63) {
      throw new RangeError("limited entry needs max admits between 2 and 63");
    }
    return (MODE_TO_BITS.limited << 6) | maxAdmits;
  }
  return MODE_TO_BITS[mode] << 6;
}

export function decodeEntryRule(byte: number): EntryRule {
  if (!Number.isInteger(byte) || byte < 0 || byte > 0xff)
    throw new RangeError("entry_rule must be a byte");
  const bits = byte >> 6;
  const low = byte & 0x3f;
  if (bits === 0 && low === 0) return { mode: "single", maxAdmits: 1 };
  if (bits === 1 && low === 0) return { mode: "unlimited", maxAdmits: null };
  if (bits === 2 && low >= 2) return { mode: "limited", maxAdmits: low };
  throw new RangeError("invalid entry_rule byte");
}
