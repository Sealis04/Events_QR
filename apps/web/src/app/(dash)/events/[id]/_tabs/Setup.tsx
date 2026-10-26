"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { EventForm } from "../../../../_components/EventForm";
import { Notice } from "../../../../_components/Shell";
import { api } from "../../../../_lib/client";
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

/** Admin only, VM only: event details, gates and ticket types (saved together), and who works the event. */
export function Setup({ event, onChanged }: { event: EventView; onChanged: () => void }) {
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string }>();
  const [staff, setStaff] = useState<StaffRow[]>([]);

  const loadStaff = useCallback(async () => {
    try {
      setStaff((await api<{ staff: StaffRow[] }>(`/api/events/${event.id}/staff`)).staff);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load staff" });
    }
  }, [event.id]);
  useEffect(() => void loadStaff(), [loadStaff]);

  const fail = (err: unknown) =>
    setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });

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
      {/* Remounts after a save so the form starts from what the server now says. */}
      <EventForm
        key={JSON.stringify(event)}
        event={event}
        onSaved={() => {
          setMsg({
            tone: "ok",
            text: "Saved. Changes to a ticket type apply to tickets issued from now on.",
          });
          onChanged();
        }}
      />

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
