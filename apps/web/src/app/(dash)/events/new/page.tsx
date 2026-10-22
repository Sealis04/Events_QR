"use client";

import { useState, type FormEvent } from "react";
import { Notice, Shell } from "../../../_components/Shell";
import {
  draftToInput,
  emptyDraft,
  TypeFields,
  type TypeDraft,
} from "../../../_components/TypeFields";
import { api, unixFromLocal } from "../../../_lib/client";

function NewEvent() {
  const [gates, setGates] = useState<string[]>(["Gate A", "Gate B"]);
  const [types, setTypes] = useState<TypeDraft[]>([{ ...emptyDraft(2), name: "GA" }]);
  const [error, setError] = useState("");

  /** Keeps every type's gate flags the same length as the gate list. */
  const setGateNames = (next: string[]) => {
    setGates(next);
    setTypes((cur) => cur.map((t) => ({ ...t, gates: next.map((_, i) => t.gates[i] ?? false) })));
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const cleanGates = gates.map((g) => g.trim());
    if (cleanGates.some((g) => !g)) return setError("Gate names cannot be blank.");
    const ticket_types: Record<string, unknown>[] = [];
    for (const [idx, draft] of types.entries()) {
      const input = draftToInput(draft);
      if (!input.ok) return setError(input.error);
      ticket_types.push({ idx, ...input.value });
    }
    if (ticket_types.length === 0) return setError("Add at least one ticket type.");
    try {
      const created = await api<{ id: number }>("/api/events", {
        body: {
          name: String(f.get("name")).trim(),
          venue: String(f.get("venue")).trim() || undefined,
          timezone: String(f.get("timezone")).trim() || undefined,
          starts_at: unixFromLocal(String(f.get("starts"))),
          ends_at: unixFromLocal(String(f.get("ends"))),
          gates: cleanGates,
          ticket_types,
        },
      });
      window.location.href = `/events/${created.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create the event");
    }
  }

  return (
    <form className="grid" onSubmit={submit}>
      <div className="card">
        <h2>Event</h2>
        <div className="cols">
          <label className="field">
            Name
            <input name="name" required aria-label="Event name" />
          </label>
          <label className="field">
            Venue
            <input name="venue" aria-label="Venue" />
          </label>
          <label className="field">
            Doors open
            <input name="starts" type="datetime-local" required aria-label="Doors open" />
          </label>
          <label className="field">
            Ends
            <input name="ends" type="datetime-local" required aria-label="Ends" />
          </label>
          <label className="field">
            Time zone (IANA, blank = the server&apos;s)
            <input name="timezone" placeholder="Asia/Manila" aria-label="Time zone" />
          </label>
        </div>
      </div>

      <div className="card">
        <h2>Gates</h2>
        <p className="muted">
          Up to 16. The order is fixed once tickets exist; gates can only be added after that.
        </p>
        {gates.map((g, i) => (
          <div className="row" key={i} style={{ marginBottom: 6 }}>
            <input
              value={g}
              aria-label={`Gate ${i + 1}`}
              onChange={(e) => setGateNames(gates.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              type="button"
              className="secondary"
              disabled={i === 0}
              onClick={() => {
                const swap = <T,>(list: T[]): T[] => {
                  const copy = [...list];
                  [copy[i - 1], copy[i]] = [copy[i]!, copy[i - 1]!];
                  return copy;
                };
                setGates(swap(gates));
                setTypes((cur) => cur.map((t) => ({ ...t, gates: swap(t.gates) })));
              }}
            >
              Up
            </button>
            <button
              type="button"
              className="secondary"
              disabled={gates.length === 1}
              onClick={() => {
                setGates(gates.filter((_, j) => j !== i));
                setTypes((cur) =>
                  cur.map((t) => ({ ...t, gates: t.gates.filter((_, j) => j !== i) })),
                );
              }}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="secondary"
          disabled={gates.length >= 16}
          onClick={() => setGateNames([...gates, `Gate ${gates.length + 1}`])}
        >
          Add gate
        </button>
      </div>

      <div>
        <h2>Ticket types</h2>
        {types.map((t, i) => (
          <TypeFields
            key={i}
            draft={t}
            gates={gates}
            onChange={(next) => setTypes(types.map((x, j) => (j === i ? next : x)))}
            onRemove={
              types.length > 1 ? () => setTypes(types.filter((_, j) => j !== i)) : undefined
            }
          />
        ))}
        <button
          type="button"
          className="secondary"
          onClick={() => setTypes([...types, emptyDraft(gates.length)])}
        >
          Add ticket type
        </button>
      </div>

      {error && <Notice tone="bad">{error}</Notice>}
      <div>
        <button type="submit">Create event</button>
      </div>
    </form>
  );
}

export default function NewEventPage() {
  return (
    <Shell title="New event" back={{ href: "/", label: "Events" }}>
      {(me) =>
        me.mode === "hub" ? (
          <Notice tone="warn">Events are set up on the VM, not on the venue hub.</Notice>
        ) : me.role !== "admin" ? (
          <Notice tone="warn">Only admins can create events.</Notice>
        ) : (
          <NewEvent />
        )
      }
    </Shell>
  );
}
