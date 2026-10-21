"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../_lib/client";

interface TicketType {
  idx: number;
  name: string;
  capacity: number | null;
  issued: number;
}
interface EventView {
  id: number;
  name: string;
  venue: string | null;
  gates: string[];
  ticket_types: TicketType[];
}
interface Issued {
  ticket_id: string;
  holder_name: string | null;
  short_id: string;
  qr_png: string;
}

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<EventView>();
  const [issued, setIssued] = useState<Issued[]>([]);
  const [error, setError] = useState("");
  const [typeIdx, setTypeIdx] = useState(0);

  const load = useCallback(async () => {
    try {
      const view = await api<EventView>(`/api/events/${id}`);
      setEvent(view);
      setTypeIdx(
        (cur) =>
          view.ticket_types.find((t) => t.idx === cur)?.idx ?? view.ticket_types[0]?.idx ?? 0,
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) window.location.href = "/login";
      else setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const res = await api<{ tickets: Issued[] }>(`/api/events/${id}/tickets`, {
        body: {
          idempotency_key: crypto.randomUUID(),
          ticket_type: typeIdx,
          quantity: Number(f.get("quantity") || 1),
          holder_name: f.get("name") || undefined,
          holder_email: f.get("email") || undefined,
          note: f.get("note") || undefined,
        },
      });
      setIssued(res.tickets);
      setError("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to generate");
    }
  }

  if (!event) return <p>{error || "Loading…"}</p>;
  return (
    <main>
      <p>
        <a href="/">← Events</a>
      </p>
      <h1>{event.name}</h1>
      <p>
        {event.venue ?? "no venue"} · gates: {event.gates.join(", ")}
      </p>
      <ul>
        {event.ticket_types.map((t) => (
          <li key={t.idx}>
            {t.name}: {t.issued}
            {t.capacity !== null ? ` / ${t.capacity}` : ""} issued
          </li>
        ))}
      </ul>

      <h2>Generate tickets</h2>
      <form onSubmit={generate} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
        <select
          value={typeIdx}
          onChange={(e) => setTypeIdx(Number(e.target.value))}
          aria-label="Ticket type"
        >
          {event.ticket_types.map((t) => (
            <option key={t.idx} value={t.idx}>
              {t.name}
            </option>
          ))}
        </select>
        <input name="name" placeholder="Holder name (blank for numbered batch names)" />
        <input name="email" type="email" placeholder="Email (optional)" />
        <input
          name="quantity"
          type="number"
          min={1}
          max={500}
          defaultValue={1}
          aria-label="Quantity"
        />
        <input name="note" placeholder="Internal note (optional)" />
        <button type="submit">Generate</button>
      </form>
      {error && (
        <p role="alert" style={{ color: "crimson" }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 16 }}>
        {issued.map((t) => (
          <figure key={t.ticket_id} style={{ margin: 0, textAlign: "center" }}>
            <img
              src={t.qr_png}
              alt={`QR for ${t.holder_name ?? t.short_id}`}
              width={260}
              height={260}
            />
            <figcaption>
              {t.holder_name}
              <br />
              <code>{t.short_id}</code>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}
