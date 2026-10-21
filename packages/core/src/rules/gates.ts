export const MAX_GATES = 16;

/** One bit per gate, by position in the event's gate list. Index 0 is bit 0. */
export function gatesToMask(gateIndexes: readonly number[]): number {
  let mask = 0;
  for (const i of gateIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= MAX_GATES)
      throw new RangeError("gate index out of range");
    mask |= 1 << i;
  }
  return mask;
}

/** Gate indexes set in the mask, ascending. `0` (any gate) gives an empty list. */
export function maskToGates(mask: number): number[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff)
    throw new RangeError("gate_mask must be 16 bits");
  const out: number[] = [];
  for (let i = 0; i < MAX_GATES; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

/** `mask === 0` means any gate. */
export function isGateAllowed(mask: number, gateIndex: number | undefined): boolean {
  if (mask === 0) return true;
  if (gateIndex === undefined || gateIndex < 0 || gateIndex >= MAX_GATES) return false;
  return (mask & (1 << gateIndex)) !== 0;
}
