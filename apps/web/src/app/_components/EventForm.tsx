"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  eventDays,
  offsetLabel,
  unixFromZoned,
  zonedFromUnix,
} from "../_lib/client";
import type { EventView } from "../_lib/types";
import { GateEditor } from "./GateEditor";
import { Notice } from "./Shell";
import {
  draftToInput,
  problemsOf,
  PRESETS,
  TypesEditor,
  typeToDraft,
  type TypeDraft,
  type TypeProblem,
} from "./TypeFields";

function zoneList(extra?: string): string[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf(
      "timeZone",
    );
  } catch {
    zones = [];
  }
  const all = new Set(["UTC", ...zones]);
  if (extra) all.add(extra);
  return [...all].sort();
}

/** The next whole hour in `tz` as a `datetime-local` value, `plusHours` later. */
const defaultLocal = (tz: string, plusHours: number): string => {
  const now = Math.floor(Date.now() / 1000);
  return zonedFromUnix(Math.ceil(now / 3600) * 3600 + plusHours * 3600, tz);
};

interface Fields {
  name?: string;
  starts?: string;
  ends?: string;
  gates?: string;
  form?: string;
}

/**
 * Event details, gates and ticket types in numbered cards with a sticky save bar. `create` posts a new
 * event; `edit` (the Setup tab) saves every change in one go, with errors next to the field.
 */
export function EventForm({
  event,
  defaultTimezone,
  onSaved,
}: {
  event?: EventView;
  defaultTimezone?: string;
  onSaved: (id: number) => void;
}) {
  const edit = !!event;
  const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initialTz = event?.timezone ?? defaultTimezone ?? browserZone;
  const [tz, setTz] = useState(initialTz);
  const [name, setName] = useState(event?.name ?? "");
  const [venue, setVenue] = useState(event?.venue ?? "");
  const [starts, setStarts] = useState(
    event ? zonedFromUnix(event.starts_at, initialTz) : defaultLocal(initialTz, 24),
  );
  const [ends, setEnds] = useState(
    event ? zonedFromUnix(event.ends_at, initialTz) : defaultLocal(initialTz, 30),
  );
  const [gates, setGates] = useState<string[]>(event?.gates ?? ["Gate A", "Gate B"]);
  const [gateOnly, setGateOnly] = useState(event?.offline_gate_only ?? false);
  const original = useMemo(
    () => event?.ticket_types.map((t) => typeToDraft(t, event.gates.length)) ?? [],
    [event],
  );
  const [types, setTypes] = useState<TypeDraft[]>(() =>
    event ? original : [{ ...PRESETS[0]!.make(2), name: "GA" }],
  );
  const [fields, setFields] = useState<Fields>({});
  const [problems, setProblems] = useState<TypeProblem[]>([]);
  const [busy, setBusy] = useState(false);

  const hasTickets = !!event?.ticket_types.some((t) => t.issued > 0);
  const lockedGates = hasTickets ? event!.gates.length : 0;
  const zones = useMemo(() => zoneList(initialTz), [initialTz]);
  const startUnix = unixFromZoned(starts, tz);
  const endUnix = unixFromZoned(ends, tz);
  const days = useMemo(
    () =>
      eventDays(
        Number.isFinite(startUnix) ? startUnix : Math.floor(Date.now() / 1000),
        Number.isFinite(endUnix) ? endUnix : Math.floor(Date.now() / 1000),
        tz,
        Math.max(1, ...types.flatMap((t) => t.slots.map((s) => s.day + 1))),
      ),
    [startUnix, endUnix, tz, types],
  );
  const places = types.every((t) => t.capacity.trim() !== "")
    ? types.reduce((n, t) => n + (Number(t.capacity) || 0), 0)
    : null;

  /** Carries every type's gate flags through a reorder / add / remove of gates. */
  function changeGates(next: string[], remap: number[]) {
    setGates(next);
    setTypes((cur) =>
      cur.map((t) => ({
        ...t,
        gates: remap.map((old) => (old < 0 ? false : (t.gates[old] ?? false))),
      })),
    );
  }

  function check(): { ok: boolean; found: Fields; list: TypeProblem[] } {
    const found: Fields = {};
    if (!name.trim()) found.name = "Give the event a name.";
    if (!Number.isFinite(startUnix)) found.starts = "Pick when the doors open.";
    if (!Number.isFinite(endUnix)) found.ends = "Pick when the event ends.";
    else if (Number.isFinite(startUnix) && endUnix <= startUnix)
      found.ends = "The event must end after the doors open.";
    if (gates.length === 0) found.gates = "Add at least one gate.";
    if (types.length === 0) found.form = "Add at least one ticket type.";
    const list = problemsOf(types);
    return { ok: Object.keys(found).length === 0 && list.length === 0, found, list };
  }

  function serverError(err: unknown, fallback: string): Fields {
    const msg = err instanceof Error ? err.message : fallback;
    if (err instanceof ApiError && /gate/i.test(msg)) return { gates: msg };
    if (/ends_at/.test(msg)) return { ends: msg };
    return { form: msg };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const { ok, found, list } = check();
    setFields(found);
    setProblems(list);
    if (!ok) return;
    setBusy(true);
    try {
      if (!edit) {
        const ticket_types = types.map((t, idx) => ({
          idx,
          ...(draftToInput(t) as { ok: true; value: Record<string, unknown> }).value,
        }));
        const created = await api<{ id: number }>("/api/events", {
          body: {
            name: name.trim(),
            venue: venue.trim() || undefined,
            timezone: tz,
            starts_at: startUnix,
            ends_at: endUnix,
            gates,
            ticket_types,
          },
        });
        onSaved(created.id);
        return;
      }
      const e0 = event!;
      const patch: Record<string, unknown> = {};
      if (name.trim() !== e0.name) patch.name = name.trim();
      if (venue.trim() !== (e0.venue ?? "")) patch.venue = venue.trim() || null;
      if (!hasTickets && startUnix !== e0.starts_at) patch.starts_at = startUnix;
      if (endUnix !== e0.ends_at) patch.ends_at = endUnix;
      if (gateOnly !== e0.offline_gate_only) patch.offline_gate_only = gateOnly;
      if (JSON.stringify(gates) !== JSON.stringify(e0.gates)) patch.gates = gates;
      if (Object.keys(patch).length > 0)
        await api(`/api/events/${e0.id}`, { method: "PATCH", body: patch });
      for (const [i, t] of types.entries()) {
        const body = (draftToInput(t) as { ok: true; value: Record<string, unknown> }).value;
        try {
          if (t.idx === undefined) await api(`/api/events/${e0.id}/ticket-types`, { body });
          else if (JSON.stringify(t) !== JSON.stringify(original.find((o) => o.idx === t.idx)))
            await api(`/api/events/${e0.id}/ticket-types/${t.idx}`, { method: "PATCH", body });
        } catch (err) {
          setProblems([
            { index: i, field: "form", message: err instanceof Error ? err.message : "failed" },
          ]);
          throw err;
        }
      }
      onSaved(e0.id);
    } catch (err) {
      setFields(serverError(err, "could not save"));
    } finally {
      setBusy(false);
    }
  }

  const reset = () => {
    if (!event) return;
    setName(event.name);
    setVenue(event.venue ?? "");
    setStarts(zonedFromUnix(event.starts_at, initialTz));
    setEnds(zonedFromUnix(event.ends_at, initialTz));
    setGates(event.gates);
    setGateOnly(event.offline_gate_only);
    setTypes(original);
    setFields({});
    setProblems([]);
  };

  return (
    <form onSubmit={submit} noValidate aria-label={edit ? "Event details" : "New event"}>
      <section className="card">
        <div className="step">
          <span className="n">1</span>
          <h2>Event details</h2>
        </div>
        <div className="cols">
          <label className="field">
            Event name
            <input
              value={name}
              aria-label="Event name"
              aria-invalid={!!fields.name}
              onChange={(e) => setName(e.target.value)}
            />
            {fields.name && <span className="field-error">{fields.name}</span>}
          </label>
          <label className="field">
            Venue
            <input value={venue} aria-label="Venue" onChange={(e) => setVenue(e.target.value)} />
          </label>
          <label className="field">
            Time zone
            <select
              value={tz}
              aria-label="Time zone"
              disabled={edit}
              onChange={(e) => setTz(e.target.value)}
            >
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z} ({offsetLabel(z)})
                </option>
              ))}
            </select>
            {edit && (
              <span className="hint">Fixed once the event exists: slot times depend on it.</span>
            )}
          </label>
          <label className="field">
            Doors open
            <input
              type="datetime-local"
              value={starts}
              aria-label="Doors open"
              aria-invalid={!!fields.starts}
              disabled={hasTickets}
              onChange={(e) => setStarts(e.target.value)}
            />
            {hasTickets && (
              <span className="hint">
                Cannot change once tickets exist: slot times are relative to it.
              </span>
            )}
            {fields.starts && <span className="field-error">{fields.starts}</span>}
          </label>
          <label className="field">
            Ends
            <input
              type="datetime-local"
              value={ends}
              aria-label="Ends"
              aria-invalid={!!fields.ends}
              onChange={(e) => setEnds(e.target.value)}
            />
            {fields.ends && <span className="field-error">{fields.ends}</span>}
          </label>
        </div>
        {edit && (
          <label className="check" style={{ marginTop: 8 }}>
            <input
              type="checkbox"
              checked={gateOnly}
              onChange={(e) => setGateOnly(e.target.checked)}
            />
            Offline phones admit only tickets whose signed gates include their gate
          </label>
        )}
      </section>

      <section className="card">
        <div className="between" style={{ flexWrap: "wrap", marginBottom: 12 }}>
          <div className="step" style={{ margin: 0 }}>
            <span className="n">2</span>
            <h2>Gates</h2>
          </div>
          <span className="small muted">
            Drag to reorder · {gates.length} of 16 ·{" "}
            {hasTickets ? "🔒 order locked, tickets exist" : "order locks once tickets exist"}
          </span>
        </div>
        <GateEditor
          gates={gates}
          locked={lockedGates}
          error={fields.gates}
          onChange={changeGates}
        />
      </section>

      <section className="card">
        <div className="between" style={{ flexWrap: "wrap", marginBottom: 12 }}>
          <div className="step" style={{ margin: 0 }}>
            <span className="n">3</span>
            <h2>Ticket types</h2>
          </div>
          <span className="small muted">
            {places === null ? "No overall limit" : `${places.toLocaleString()} places in total`}
          </span>
        </div>
        <TypesEditor
          types={types}
          gates={gates}
          days={days}
          problems={problems}
          onChange={setTypes}
          canRemove={(d) => d.idx === undefined}
        />
      </section>

      {fields.form && <Notice tone="bad">{fields.form}</Notice>}
      <div className="sticky-bar">
        <span className="small">
          {gates.length} gate{gates.length === 1 ? "" : "s"} · {types.length} ticket type
          {types.length === 1 ? "" : "s"} · {places === null ? "no limit" : places.toLocaleString()}
        </span>
        <div className="row">
          {edit ? (
            <button type="button" className="secondary" onClick={reset}>
              Discard changes
            </button>
          ) : (
            <a className="btn secondary" href="/">
              Cancel
            </a>
          )}
          <button type="submit" disabled={busy}>
            {edit ? "Save changes" : "Create event"}
          </button>
        </div>
      </div>
    </form>
  );
}
