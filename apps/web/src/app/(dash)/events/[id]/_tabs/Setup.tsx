"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Notice } from "../../../../_components/Shell";
import {
  draftToInput,
  emptyDraft,
  TypeFields,
  typeToDraft,
  type TypeDraft,
} from "../../../../_components/TypeFields";
import { api, localFromUnix, unixFromLocal } from "../../../../_lib/client";
import type { EventView } from "../../../../_lib/types";

interface StaffRow {
  id: string;
  name: string;
  role: "staff" | "supervisor" | "admin";
  assignment: "issued" | "added" | "removed" | null;
  assigned: boolean;
  pin_reset: "weak" | "rotate" | null;
}

const reason = { issued: "issued tickets", added: "added", removed: "removed", null: "" } as const;

/** Admin only, VM only: event details, ticket types, and who works the event (whose PIN hashes go to phones). */
export function Setup({ event, onChanged }: { event: EventView; onChanged: () => void }) {
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string }>();
  const [types, setTypes] = useState<TypeDraft[]>(() =>
    event.ticket_types.map((t) => typeToDraft(t, event.gates.length)),
  );
  const [newGate, setNewGate] = useState("");
  const [staff, setStaff] = useState<StaffRow[]>([]);

  const loadStaff = useCallback(async () => {
    try {
      setStaff((await api<{ staff: StaffRow[] }>(`/api/events/${event.id}/staff`)).staff);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load staff" });
    }
  }, [event.id]);
  useEffect(() => void loadStaff(), [loadStaff]);
  useEffect(
    () => setTypes(event.ticket_types.map((t) => typeToDraft(t, event.gates.length))),
    [event],
  );

  const done = async (text: string) => {
    setMsg({ tone: "ok", text });
    onChanged();
  };
  const fail = (err: unknown) =>
    setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });

  async function saveEvent(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/api/events/${event.id}`, {
        method: "PATCH",
        body: {
          name: String(f.get("name")).trim(),
          venue: String(f.get("venue")).trim() || null,
          ends_at: unixFromLocal(String(f.get("ends"))),
          offline_gate_only: f.get("gateOnly") === "on",
        },
      });
      await done("Event saved.");
    } catch (err) {
      fail(err);
    }
  }

  async function addGate() {
    if (!newGate.trim()) return;
    try {
      await api(`/api/events/${event.id}`, {
        method: "PATCH",
        body: { gates: [...event.gates, newGate.trim()] },
      });
      setNewGate("");
      await done("Gate added.");
    } catch (err) {
      fail(err);
    }
  }

  async function saveType(draft: TypeDraft) {
    const input = draftToInput(draft);
    if (!input.ok) return setMsg({ tone: "bad", text: input.error });
    try {
      if (draft.idx === undefined)
        await api(`/api/events/${event.id}/ticket-types`, { body: input.value });
      else
        await api(`/api/events/${event.id}/ticket-types/${draft.idx}`, {
          method: "PATCH",
          body: input.value,
        });
      await done(`${draft.name}: saved. It applies to tickets issued from now on.`);
    } catch (err) {
      fail(err);
    }
  }

  async function assign(s: StaffRow, assigned: boolean | null) {
    try {
      await api(`/api/events/${event.id}/staff/${s.id}`, { method: "PUT", body: { assigned } });
      await loadStaff();
    } catch (err) {
      fail(err);
    }
  }

  async function addStaff(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      const created = await api<{ id: string }>("/api/staff", {
        body: {
          name: String(f.get("name")).trim(),
          pin: String(f.get("pin")),
          role: String(f.get("role")),
        },
      });
      await api(`/api/events/${event.id}/staff/${created.id}`, {
        method: "PUT",
        body: { assigned: true },
      });
      form.reset();
      await loadStaff();
      setMsg({ tone: "ok", text: "Staff member created and added to this event." });
    } catch (err) {
      fail(err);
    }
  }

  return (
    <div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <form className="card grid" onSubmit={saveEvent} aria-label="Event details">
        <h3>Event</h3>
        <div className="cols">
          <label className="field">
            Name
            <input name="name" defaultValue={event.name} required aria-label="Event name" />
          </label>
          <label className="field">
            Venue
            <input name="venue" defaultValue={event.venue ?? ""} aria-label="Venue" />
          </label>
          <label className="field">
            Ends
            <input
              name="ends"
              type="datetime-local"
              defaultValue={localFromUnix(event.ends_at)}
              aria-label="Ends"
            />
          </label>
        </div>
        <p className="muted">
          Doors-open time ({new Date(event.starts_at * 1000).toLocaleString()}) cannot change once
          tickets exist: slot times are relative to it.
        </p>
        <label className="row">
          <input name="gateOnly" type="checkbox" defaultChecked={event.offline_gate_only} /> Offline
          phones admit only tickets whose signed gates include their gate
        </label>
        <div>
          <button type="submit">Save event</button>
        </div>
      </form>

      <div className="card">
        <h3>Gates</h3>
        <p>{event.gates.map((g, i) => `${i + 1}. ${g}`).join("   ")}</p>
        <p className="muted">
          The order is fixed once tickets exist; new gates are added at the end.
        </p>
        <div className="row">
          <input
            value={newGate}
            onChange={(e) => setNewGate(e.target.value)}
            placeholder="New gate"
            aria-label="New gate"
          />
          <button className="secondary" onClick={addGate} disabled={event.gates.length >= 16}>
            Add gate
          </button>
        </div>
      </div>

      <h3>Ticket types</h3>
      {types.map((t, i) => (
        <div key={t.idx ?? `new-${i}`}>
          <TypeFields
            draft={t}
            gates={event.gates}
            onChange={(next) => setTypes(types.map((x, j) => (j === i ? next : x)))}
          />
          <p>
            <button onClick={() => saveType(t)}>
              {t.idx === undefined ? "Add type" : `Save ${t.name || "type"}`}
            </button>
          </p>
        </div>
      ))}
      <button
        className="secondary"
        onClick={() => setTypes([...types, emptyDraft(event.gates.length)])}
      >
        New ticket type
      </button>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>Staff on this event</h3>
        <p className="muted">
          Phones and the hub receive PIN hashes only for these people, and stop receiving them when
          the event ends. Anyone who issued tickets is on the list by default. Removing someone
          takes their hash off the phones at the next sync.
        </p>
        <div className="table-wrap">
          <table data-testid="event-staff">
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>On this event</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    {s.pin_reset && (
                      <span className="pill warn" style={{ marginLeft: 6 }}>
                        must change PIN
                      </span>
                    )}
                  </td>
                  <td>{s.role}</td>
                  <td>
                    {s.assigned ? "yes" : "no"}{" "}
                    <span className="muted">{reason[s.assignment ?? "null"]}</span>
                  </td>
                  <td>
                    <div className="row">
                      <button className="secondary" onClick={() => assign(s, !s.assigned)}>
                        {s.assigned ? "Remove" : "Add"}
                      </button>
                      {s.assignment && (
                        <button className="secondary" onClick={() => assign(s, null)}>
                          Reset to default
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form className="row" onSubmit={addStaff} style={{ marginTop: 10 }} aria-label="Add staff">
          <input name="name" placeholder="New staff name" required aria-label="Staff name" />
          <select name="role" defaultValue="staff" aria-label="Staff role">
            <option value="staff">staff (PIN 6+ characters)</option>
            <option value="supervisor">supervisor (PIN 8+ digits)</option>
            <option value="admin">admin (PIN 8+ digits)</option>
          </select>
          <input
            name="pin"
            type="password"
            placeholder="PIN"
            required
            autoComplete="new-password"
            aria-label="Staff PIN"
          />
          <button type="submit">Create and add</button>
        </form>
      </div>
    </div>
  );
}
