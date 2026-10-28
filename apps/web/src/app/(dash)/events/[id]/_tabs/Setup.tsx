"use client";

import { useCallback, useEffect, useState } from "react";
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
  pin_reset: "weak" | "rotate" | "admin" | null;
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
        <p className="small" style={{ marginTop: 10 }}>
          Need a new account, a PIN reset or a role change? <a href="/staff">Manage accounts</a>
        </p>
      </div>
    </div>
  );
}
