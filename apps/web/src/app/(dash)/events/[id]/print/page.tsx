"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "../../../../_lib/client";

interface Detail {
  ticket_id: string;
  holder_name: string | null;
  event_name: string;
  type_name: string;
  short_id: string;
  qr_png: string;
}

/** A print-styled page: each ticket's QR with its caption (name, event, type, last 6 hex). Use the browser's Print or "Save as PDF". */
export default function PrintPage() {
  const { id } = useParams<{ id: string }>();
  const [tickets, setTickets] = useState<Detail[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const ids = (new URLSearchParams(window.location.search).get("ids") ?? "")
      .split(",")
      .filter(Boolean);
    Promise.all(ids.map((t) => api<Detail>(`/api/tickets/${t}`)))
      .then(setTickets)
      .catch((err) => {
        if (err?.status === 401) window.location.href = "/login";
        else setError(err instanceof Error ? err.message : "failed to load");
      });
  }, [id]);

  return (
    <main className="page">
      <div className="no-print row" style={{ marginBottom: 12 }}>
        <button onClick={() => window.print()}>Print / Save as PDF</button>
        <a href={`/events/${id}`}>Back to the event</a>
        {error && <span role="alert">{error}</span>}
      </div>
      <div className="print-sheet" data-testid="print-sheet">
        {tickets.map((t) => (
          <figure key={t.ticket_id} className="print-ticket" style={{ margin: 0 }}>
            <img src={t.qr_png} alt={`QR for ${t.holder_name ?? t.short_id}`} />
            <figcaption>
              <div className="name">{t.holder_name}</div>
              <div>{t.event_name}</div>
              <div>{t.type_name}</div>
              <code data-testid="print-short-id">{t.short_id}</code>
            </figcaption>
          </figure>
        ))}
      </div>
    </main>
  );
}
