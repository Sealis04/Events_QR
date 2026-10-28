"use client";

import { useState } from "react";
import { clockToMinutes, minutesToClock, SLOT_OPEN_END } from "../_lib/client";
import type { TicketType } from "../_lib/types";

export interface SlotDraft {
  /** Days after the event's first day. */
  day: number;
  from: string;
  /** Blank = until the event ends. Earlier than `from` = after midnight, the next day. */
  until: string;
}

/** A ticket type as typed into the form; strings so half-typed values do not fight the inputs. */
export interface TypeDraft {
  idx?: number;
  name: string;
  capacity: string;
  mode: "single" | "unlimited" | "limited";
  maxAdmits: string;
  /** One flag per gate of the event, in gate order. None ticked = every gate. */
  gates: boolean[];
  slots: SlotDraft[];
  early: string;
}

export interface Day {
  day: number;
  label: string;
}

export type TypeField = "name" | "capacity" | "maxAdmits" | "slots" | "early";
export interface TypeProblem {
  /** Position in the list of drafts. */
  index: number;
  field: TypeField | "form";
  message: string;
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

export const PRESETS: { label: string; make: (gateCount: number) => TypeDraft }[] = [
  {
    label: "General admission",
    make: (n) => ({ ...emptyDraft(n), name: "General admission" }),
  },
  { label: "VIP", make: (n) => ({ ...emptyDraft(n), name: "VIP" }) },
  {
    label: "Day pass",
    make: (n) => ({ ...emptyDraft(n), name: "Day pass", mode: "unlimited" }),
  },
  { label: "Blank", make: emptyDraft },
];

export function typeToDraft(t: TicketType, gateCount: number): TypeDraft {
  return {
    idx: t.idx,
    name: t.name,
    capacity: t.capacity === null ? "" : String(t.capacity),
    mode: t.entry_rule.mode,
    maxAdmits: String(t.entry_rule.max_admits ?? 3),
    gates: Array.from({ length: gateCount }, (_, i) => ((t.gate_mask >> i) & 1) === 1),
    slots: t.slots.map((s) => {
      const day = Math.floor(s.start / 1440);
      const endsOpen = s.end === SLOT_OPEN_END;
      return {
        day,
        from: minutesToClock(s.start - day * 1440),
        until: endsOpen
          ? ""
          : minutesToClock(
              s.end - day * 1440 >= 1440 ? s.end - (day + 1) * 1440 : s.end - day * 1440,
            ),
      };
    }),
    early: String(t.early_entry_min),
  };
}

export const gateMaskOf = (flags: boolean[]): number =>
  flags.reduce((mask, on, i) => (on ? mask | (1 << i) : mask), 0);

type Built =
  { ok: true; value: Record<string, unknown> } | { ok: false; field: TypeField; error: string };

/** The API body for this draft, or the first problem with the field it belongs to. */
export function draftToInput(d: TypeDraft): Built {
  const name = d.name.trim();
  if (!name) return { ok: false, field: "name", error: "Give this ticket type a name." };
  const capacity = d.capacity.trim() === "" ? null : Number(d.capacity);
  if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1))
    return {
      ok: false,
      field: "capacity",
      error: "Tickets available: a whole number of 1 or more, or blank.",
    };
  const max = Number(d.maxAdmits);
  if (d.mode === "limited" && (!Number.isInteger(max) || max < 2 || max > 63))
    return { ok: false, field: "maxAdmits", error: "Enter a number from 2 to 63." };
  // The early-entry box is only shown for types with a time slot; without one a stray value is not an error.
  let early = Number(d.early);
  if (!Number.isInteger(early) || early < 15 || early > 30) {
    if (d.slots.length > 0)
      return { ok: false, field: "early", error: "Early entry is 15 to 30 minutes." };
    early = 15;
  }
  const slots: { start: number; end: number }[] = [];
  for (const s of d.slots) {
    const from = clockToMinutes(s.from);
    const until = s.until.trim() === "" ? SLOT_OPEN_END : clockToMinutes(s.until);
    if (from === undefined || until === undefined || (until !== SLOT_OPEN_END && until === from))
      return {
        ok: false,
        field: "slots",
        error: "Each time needs a From and an Until (HH:MM), and they cannot be the same.",
      };
    const start = s.day * 1440 + from;
    const end =
      until === SLOT_OPEN_END ? SLOT_OPEN_END : s.day * 1440 + until + (until < from ? 1440 : 0);
    if (start > 0xfffe || (end !== SLOT_OPEN_END && end > 0xfffe))
      return { ok: false, field: "slots", error: "That time is too far from the first day." };
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

/** Every problem in a list of drafts (first one per draft). */
export function problemsOf(drafts: TypeDraft[]): TypeProblem[] {
  const out: TypeProblem[] = [];
  drafts.forEach((d, index) => {
    const r = draftToInput(d);
    if (!r.ok) out.push({ index, field: r.field, message: r.error });
  });
  return out;
}

const addMinutes = (clock: string, delta: number): string => {
  const m = clockToMinutes(clock);
  return m === undefined ? clock : minutesToClock((((m + delta) % 1440) + 1440) % 1440);
};

const ruleText = (d: TypeDraft): string =>
  d.mode === "single"
    ? "Once"
    : d.mode === "unlimited"
      ? "Any number (re-entry)"
      : `Up to ${d.maxAdmits || "N"} times`;

/** "N tickets · up to M entries each", for the type editor. */
export function summaryText(d: TypeDraft): string {
  const cap = d.capacity.trim();
  const tickets = cap === "" ? "No limit" : `${cap} ticket${cap === "1" ? "" : "s"}`;
  const entries =
    d.mode === "single"
      ? "one entry"
      : d.mode === "unlimited"
        ? "re-entry any number of times"
        : `up to ${d.maxAdmits || "N"} entries each`;
  return `${tickets} · ${entries}`;
}

const gateText = (d: TypeDraft, gates: string[]): string => {
  const names = gates.filter((_, i) => d.gates[i]);
  return names.length === 0 || names.length === gates.length ? "All gates" : names.join(", ");
};

const slotText = (s: SlotDraft, days: Day[], early: number, short = false): string => {
  const day = days.find((x) => x.day === s.day)?.label ?? `Day ${s.day + 1}`;
  const from = addMinutes(s.from, -early);
  return `${short ? day.split(" ")[0] : day} ${from}–${s.until.trim() === "" ? "end" : s.until}`;
};

/** "A VIP ticket gets the holder in once, through Main entrance or VIP lane, on Fri 6 Nov from 17:45 to 23:00." */
export function describeType(d: TypeDraft, gates: string[], days: Day[]): string {
  const times =
    d.mode === "single"
      ? "once"
      : d.mode === "unlimited"
        ? "any number of times"
        : `up to ${d.maxAdmits || "N"} times`;
  const names = gates.filter((_, i) => d.gates[i]);
  const through =
    names.length === 0 || names.length === gates.length
      ? "through any gate"
      : `through ${names.join(" or ")}`;
  const early = Number(d.early) || 15;
  const when = d.slots.length
    ? ", " +
      d.slots
        .map((s) => {
          const day = days.find((x) => x.day === s.day)?.label ?? `Day ${s.day + 1}`;
          return `on ${day} from ${addMinutes(s.from, -early)} to ${s.until.trim() === "" ? "the end of the event" : s.until}`;
        })
        .join(", and ")
    : ", at any time while the event runs";
  return `${d.name.trim() || "This"} ticket gets the holder in ${times}, ${through}${when}.`;
}

function ProblemText({
  problems,
  index,
  field,
}: {
  problems: TypeProblem[];
  index: number;
  field: TypeField;
}) {
  const p = problems.find((x) => x.index === index && x.field === field);
  return p ? (
    <span className="field-error" role="alert">
      {p.message}
    </span>
  ) : null;
}

function Editor({
  draft,
  index,
  gates,
  days,
  problems,
  onChange,
  onRemove,
  onDone,
}: {
  draft: TypeDraft;
  index: number;
  gates: string[];
  days: Day[];
  problems: TypeProblem[];
  onChange: (next: TypeDraft) => void;
  onRemove?: () => void;
  onDone: () => void;
}) {
  const set = (patch: Partial<TypeDraft>) => onChange({ ...draft, ...patch });
  const bad = (f: TypeField) => problems.some((p) => p.index === index && p.field === f);
  const allGates = !draft.gates.some(Boolean);
  const setSlot = (i: number, patch: Partial<SlotDraft>) =>
    set({ slots: draft.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  return (
    <div className="type-editor" data-testid="type-editor">
      <div className="between">
        <strong>{draft.name || "New ticket type"}</strong>
        <div className="row">
          {onRemove && (
            <button type="button" className="secondary small" onClick={onRemove}>
              Remove
            </button>
          )}
          <button type="button" className="small" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
      <div className="cols">
        <label className="field">
          Name
          <input
            value={draft.name}
            aria-label="Ticket type name"
            aria-invalid={bad("name")}
            onChange={(e) => set({ name: e.target.value })}
          />
          <ProblemText problems={problems} index={index} field="name" />
        </label>
        <label className="field">
          Tickets available
          <input
            value={draft.capacity}
            inputMode="numeric"
            aria-label="Tickets available"
            aria-invalid={bad("capacity")}
            onChange={(e) => set({ capacity: e.target.value })}
          />
          <span className="hint">Leave blank for no limit</span>
          <ProblemText problems={problems} index={index} field="capacity" />
        </label>
      </div>

      <div className="field">
        <span id={`rule-${index}`}>How many times can they get in?</span>
        <div className="chips" role="group" aria-labelledby={`rule-${index}`}>
          {(
            [
              ["single", "Once"],
              ["limited", "Up to a number"],
              ["unlimited", "Any number (re-entry)"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              className="chip"
              aria-pressed={draft.mode === mode}
              onClick={() => set({ mode })}
            >
              {label}
            </button>
          ))}
        </div>
        {draft.mode === "limited" && (
          <label className="field" style={{ maxWidth: 200 }}>
            Entries per ticket (2–63)
            <input
              value={draft.maxAdmits}
              inputMode="numeric"
              aria-label="Maximum entries"
              aria-invalid={bad("maxAdmits")}
              onChange={(e) => set({ maxAdmits: e.target.value })}
            />
            <ProblemText problems={problems} index={index} field="maxAdmits" />
          </label>
        )}
      </div>

      <div className="field">
        <span id={`gates-${index}`}>Which gates?</span>
        <div className="chips" role="group" aria-labelledby={`gates-${index}`}>
          <button
            type="button"
            className="chip"
            aria-pressed={allGates}
            onClick={() => set({ gates: draft.gates.map(() => false) })}
          >
            All gates
          </button>
          {gates.map((g, i) => (
            <button
              key={`${g}-${i}`}
              type="button"
              className="chip"
              aria-pressed={draft.gates[i] ?? false}
              onClick={() => set({ gates: draft.gates.map((on, j) => (j === i ? !on : on)) })}
            >
              {draft.gates[i] ? "✓ " : ""}
              {g}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>When can they come in?</span>
        {draft.slots.length === 0 && <span className="hint">Any time while the event runs.</span>}
        {draft.slots.map((s, i) => (
          <div className="row" key={i}>
            <select
              aria-label={`Slot ${i + 1} day`}
              value={s.day}
              onChange={(e) => setSlot(i, { day: Number(e.target.value) })}
            >
              {(days.some((d) => d.day === s.day)
                ? days
                : [...days, { day: s.day, label: `Day ${s.day + 1}` }]
              ).map((d) => (
                <option key={d.day} value={d.day}>
                  {d.label}
                </option>
              ))}
            </select>
            <input
              aria-label={`Slot ${i + 1} from`}
              value={s.from}
              placeholder="18:00"
              size={6}
              style={{ width: 84 }}
              onChange={(e) => setSlot(i, { from: e.target.value })}
            />
            <span>to</span>
            <input
              aria-label={`Slot ${i + 1} until`}
              value={s.until}
              placeholder="end"
              size={6}
              style={{ width: 84 }}
              onChange={(e) => setSlot(i, { until: e.target.value })}
            />
            <button
              type="button"
              className="secondary icon small"
              aria-label={`Remove time slot ${i + 1}`}
              onClick={() => set({ slots: draft.slots.filter((_, j) => j !== i) })}
            >
              ✕
            </button>
          </div>
        ))}
        <ProblemText problems={problems} index={index} field="slots" />
        <div>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              set({
                slots: [...draft.slots, { day: draft.slots.at(-1)?.day ?? 0, from: "", until: "" }],
              })
            }
          >
            + Add another time
          </button>
        </div>
        {draft.slots.length > 0 && (
          <>
            <label className="row early">
              Let them in up to
              <input
                value={draft.early}
                inputMode="numeric"
                aria-label="Early entry minutes"
                aria-invalid={bad("early")}
                style={{ width: 64 }}
                onChange={(e) => set({ early: e.target.value })}
              />
              minutes before their time starts
            </label>
            <ProblemText problems={problems} index={index} field="early" />
          </>
        )}
      </div>

      <div className="muted" data-testid="type-summary">
        {summaryText(draft)}
      </div>

      <div className="preview" data-testid="type-preview">
        <strong>{draft.name.trim() || "This"} ticket</strong>
        {describeType(draft, gates, days).slice(
          (draft.name.trim() || "This").length + " ticket".length,
        )}
      </div>
    </div>
  );
}

/**
 * The ticket types of an event: summary cards, one open for editing, presets to add more. Used by the
 * new-event form and the Setup tab.
 */
export function TypesEditor({
  types,
  gates,
  days,
  problems,
  onChange,
  canRemove,
  initialOpen = null,
}: {
  types: TypeDraft[];
  gates: string[];
  days: Day[];
  problems: TypeProblem[];
  onChange: (next: TypeDraft[]) => void;
  /** Types that already have an index are kept (they may have tickets); only drafts can go. */
  canRemove?: (d: TypeDraft) => boolean;
  initialOpen?: number | null;
}) {
  const [open, setOpen] = useState<number | null>(initialOpen);
  // A problem inside a collapsed card opens it, so the message is visible.
  const forced = problems[0]?.index;
  const editing = open ?? forced ?? null;
  return (
    <div className="grid">
      {types.map((t, i) =>
        editing === i ? (
          <Editor
            key={i}
            draft={t}
            index={i}
            gates={gates}
            days={days}
            problems={problems}
            onChange={(next) => onChange(types.map((x, j) => (j === i ? next : x)))}
            onRemove={
              !canRemove || canRemove(t)
                ? () => {
                    onChange(types.filter((_, j) => j !== i));
                    setOpen(null);
                  }
                : undefined
            }
            onDone={() => setOpen(null)}
          />
        ) : (
          <button
            key={i}
            type="button"
            className="type-card"
            data-testid="type-card"
            onClick={() => setOpen(i)}
            aria-label={`Edit ${t.name || "ticket type"}`}
          >
            <span className="between">
              <span className="name">{t.name || "New ticket type"}</span>
              <span className="edit-link">Edit</span>
            </span>
            <span className="row">
              <span className="tag-chip">{ruleText(t)}</span>
              <span className="tag-chip">{gateText(t, gates)}</span>
              <span className="tag-chip">
                {t.capacity.trim() ? `${t.capacity.trim()} tickets` : "No limit"}
              </span>
              {t.slots.map((s, k) => (
                <span key={k} className="tag-chip">
                  {slotText(s, days, Number(t.early) || 15, true)}
                </span>
              ))}
            </span>
            {problems.some((p) => p.index === i) && (
              <span className="field-error">{problems.find((p) => p.index === i)!.message}</span>
            )}
          </button>
        ),
      )}
      <div className="row">
        <span className="muted small">Add a ticket type:</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className="chip"
            onClick={() => {
              onChange([...types, p.make(gates.length)]);
              setOpen(types.length);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
