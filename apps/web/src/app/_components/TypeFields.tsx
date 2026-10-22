"use client";

import { clockToMinutes, minutesToClock, SLOT_OPEN_END } from "../_lib/client";
import type { TicketType } from "../_lib/types";

/** A ticket type as typed into the form; strings so half-typed values do not fight the inputs. */
export interface TypeDraft {
  idx?: number;
  name: string;
  capacity: string;
  mode: "single" | "unlimited" | "limited";
  maxAdmits: string;
  /** One flag per gate of the event, in gate order. None ticked = every gate. */
  gates: boolean[];
  /** "HH:MM" from 00:00 on the first day; a blank end means until the event ends. */
  slots: { start: string; end: string }[];
  early: string;
}

export const emptyDraft = (gateCount: number): TypeDraft => ({
  name: "",
  capacity: "",
  mode: "single",
  maxAdmits: "3",
  gates: Array.from({ length: gateCount }, () => false),
  slots: [],
  early: "15",
});

export function typeToDraft(t: TicketType, gateCount: number): TypeDraft {
  return {
    idx: t.idx,
    name: t.name,
    capacity: t.capacity === null ? "" : String(t.capacity),
    mode: t.entry_rule.mode,
    maxAdmits: String(t.entry_rule.max_admits ?? 3),
    gates: Array.from({ length: gateCount }, (_, i) => ((t.gate_mask >> i) & 1) === 1),
    slots: t.slots.map((s) => ({
      start: minutesToClock(s.start),
      end: s.end === SLOT_OPEN_END ? "" : minutesToClock(s.end),
    })),
    early: String(t.early_entry_min),
  };
}

export const gateMaskOf = (flags: boolean[]): number =>
  flags.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0);

/** The API body for this draft, or an error message. */
export function draftToInput(
  d: TypeDraft,
): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const name = d.name.trim();
  if (!name) return { ok: false, error: "Every ticket type needs a name." };
  const capacity = d.capacity.trim() === "" ? null : Number(d.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1))
    return { ok: false, error: `${name}: capacity must be a whole number of 1 or more, or blank.` };
  const max = Number(d.maxAdmits);
  if (d.mode === "limited" && (!Number.isInteger(max) || max < 2 || max > 63))
    return { ok: false, error: `${name}: "up to N entries" needs N between 2 and 63.` };
  const early = Number(d.early);
  if (!Number.isInteger(early) || early < 15 || early > 30)
    return { ok: false, error: `${name}: early entry is 15 to 30 minutes.` };
  const slots: { start: number; end: number }[] = [];
  for (const s of d.slots) {
    const start = clockToMinutes(s.start);
    const end = s.end.trim() === "" ? SLOT_OPEN_END : clockToMinutes(s.end);
    if (start === undefined || end === undefined || (end !== SLOT_OPEN_END && end <= start))
      return { ok: false, error: `${name}: each time slot needs a start before its end (HH:MM).` };
    slots.push({ start, end });
  }
  return {
    ok: true,
    value: {
      name,
      capacity,
      entry_rule: d.mode === "limited" ? { mode: "limited", max_admits: max } : { mode: d.mode },
      gate_mask: gateMaskOf(d.gates),
      slots,
      early_entry_min: early,
    },
  };
}

export function TypeFields({
  draft,
  gates,
  onChange,
  onRemove,
  locked,
}: {
  draft: TypeDraft;
  gates: string[];
  onChange: (next: TypeDraft) => void;
  onRemove?: () => void;
  locked?: boolean;
}) {
  const set = (patch: Partial<TypeDraft>) => onChange({ ...draft, ...patch });
  return (
    <fieldset className="card" disabled={locked}>
      <legend>{draft.name || "New ticket type"}</legend>
      <div className="cols">
        <label className="field">
          Name
          <input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            aria-label="Ticket type name"
          />
        </label>
        <label className="field">
          Capacity (blank = no limit)
          <input
            value={draft.capacity}
            inputMode="numeric"
            onChange={(e) => set({ capacity: e.target.value })}
            aria-label="Capacity"
          />
        </label>
        <label className="field">
          Entry rule
          <select
            value={draft.mode}
            onChange={(e) => set({ mode: e.target.value as TypeDraft["mode"] })}
            aria-label="Entry rule"
          >
            <option value="single">Single entry</option>
            <option value="unlimited">Unlimited re-entry</option>
            <option value="limited">Up to N entries</option>
          </select>
        </label>
        {draft.mode === "limited" && (
          <label className="field">
            N (2–63)
            <input
              value={draft.maxAdmits}
              inputMode="numeric"
              onChange={(e) => set({ maxAdmits: e.target.value })}
              aria-label="Maximum entries"
            />
          </label>
        )}
        <label className="field">
          Early entry (15–30 min)
          <input
            value={draft.early}
            inputMode="numeric"
            onChange={(e) => set({ early: e.target.value })}
            aria-label="Early entry minutes"
          />
        </label>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        Allowed gates (none ticked = every gate)
        <div className="row">
          {gates.map((g, i) => (
            <label key={`${g}-${i}`} className="row">
              <input
                type="checkbox"
                checked={draft.gates[i] ?? false}
                onChange={(e) => {
                  const next = [...draft.gates];
                  next[i] = e.target.checked;
                  set({ gates: next });
                }}
              />
              {g}
            </label>
          ))}
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        Time slots (HH:MM from midnight on the first day; leave the end blank for &quot;until the
        event ends&quot;)
        {draft.slots.map((s, i) => (
          <div className="row" key={i}>
            <input
              value={s.start}
              placeholder="18:00"
              size={6}
              aria-label={`Slot ${i + 1} start`}
              onChange={(e) => {
                const next = [...draft.slots];
                next[i] = { ...s, start: e.target.value };
                set({ slots: next });
              }}
            />
            –
            <input
              value={s.end}
              placeholder="22:00"
              size={6}
              aria-label={`Slot ${i + 1} end`}
              onChange={(e) => {
                const next = [...draft.slots];
                next[i] = { ...s, end: e.target.value };
                set({ slots: next });
              }}
            />
            <button
              type="button"
              className="secondary"
              onClick={() => set({ slots: draft.slots.filter((_, j) => j !== i) })}
            >
              Remove slot
            </button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="secondary"
            onClick={() => set({ slots: [...draft.slots, { start: "", end: "" }] })}
          >
            Add time slot
          </button>
        </div>
      </div>
      {onRemove && (
        <p>
          <button type="button" className="secondary" onClick={onRemove}>
            Remove this type
          </button>
        </p>
      )}
    </fieldset>
  );
}
