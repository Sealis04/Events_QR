"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, formatTime } from "./_lib/client";

interface Me {
  name: string;
  role: "staff" | "supervisor" | "admin";
}
interface EventSummary {
  id: number;
  name: string;
  venue: string | null;
  starts_at: number;
  ends_at: number;
  gates: string[];
}

/** One ticket type per line: `name, capacity (blank = no limit), single | unlimited | limited:N`. */
function parseTypes(text: string) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const [name = "", capacity = "", rule = "single"] = line.split(",").map((s) => s.trim());
      const [mode, max] = rule.split(":");
      return {
        idx,
        name,
        capacity: capacity ? Number(capacity) : null,
        entry_rule: { mode: mode || "single", max_admits: max ? Number(max) : null },
      };
    });
}

export default function Home() {
  const [me, setMe] = useState<Me>();
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/auth/me"));
      setEvents(await api<EventSummary[]>("/api/events"));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) window.location.href = "/login";
      else setError(err instanceof Error ? err.message : "failed to load");
    }
  }, []);
  useEffect(() => void load(), [load]);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget; // currentTarget is cleared after the first await
    const f = new FormData(form);
    const unix = (k: string) => Math.floor(new Date(String(f.get(k))).getTime() / 1000);
    try {
      await api("/api/events", {
        body: {
          name: f.get("name"),
          venue: f.get("venue") || undefined,
          starts_at: unix("starts"),
          ends_at: unix("ends"),
          gates: String(f.get("gates"))
            .split(",")
            .map((g) => g.trim())
            .filter(Boolean),
          ticket_types: parseTypes(String(f.get("types"))),
        },
      });
      form.reset();
      setError("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to create");
    }
  }

  async function logout() {
    await api("/api/auth/logout", { body: {} });
    window.location.href = "/login";
  }

  if (!me) return <p>{error || "Loading…"}</p>;
  return (
    <main>
      <p>
        {me.name} ({me.role}) · <button onClick={logout}>Log out</button>
      </p>
      <h1>Events</h1>
      <ul>
        {events.map((ev) => (
          <li key={ev.id}>
            <a href={`/events/${ev.id}`}>{ev.name}</a> · {ev.venue ?? "no venue"} ·{" "}
            {formatTime(ev.starts_at)} · gates: {ev.gates.join(", ")}
          </li>
        ))}
        {events.length === 0 && <li>No events yet.</li>}
      </ul>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}
      {me.role === "admin" && (
        <>
          <h2>Create event</h2>
          <form onSubmit={create} style={{ display: "grid", gap: 8, maxWidth: 480 }}>
            <input name="name" placeholder="Name" required />
            <input name="venue" placeholder="Venue" />
            <label>
              Starts <input name="starts" type="datetime-local" required />
            </label>
            <label>
              Ends <input name="ends" type="datetime-local" required />
            </label>
            <input
              name="gates"
              placeholder="Gates, comma separated"
              defaultValue="Gate A"
              required
            />
            <textarea
              name="types"
              rows={4}
              defaultValue={"GA, , single\nVIP, 100, unlimited"}
              aria-label="Ticket types"
            />
            <small>
              One ticket type per line: name, capacity (blank = no limit), single | unlimited |
              limited:N
            </small>
            <button type="submit">Create</button>
          </form>
        </>
      )}
    </main>
  );
}
