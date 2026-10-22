"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { api, ApiError, formatTime } from "../../_lib/client";

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

interface HubCodes {
  qrs: { text: string; png: string }[];
  expiresAt: number;
  gate: string;
}

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  const [event, setEvent] = useState<EventView>();
  const [issued, setIssued] = useState<Issued[]>([]);
  const [error, setError] = useState("");
  const [typeIdx, setTypeIdx] = useState(0);
  const [hubCodes, setHubCodes] = useState<HubCodes>();

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

  /** A batch of phone setup codes for the venue hub: single use, valid until the event ends. */
  async function makeHubCodes(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const gate = String(f.get("gate"));
    try {
      const res = await api<{ setup_qrs: string[]; expires_at: number }>("/api/devices/enroll", {
        body: {
          event_id: Number(id),
          gate,
          direction: String(f.get("direction")),
          count: Number(f.get("count") || 10),
          for_hub: true,
        },
      });
      const qrs = await Promise.all(
        res.setup_qrs.map(async (text) => ({
          text,
          png: await QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 4, scale: 6 }),
        })),
      );
      setHubCodes({ qrs, expiresAt: res.expires_at, gate });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to make setup codes");
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

      <h2>Phone setup codes for the venue hub</h2>
      <p>
        Single-use setup QRs that stay valid until the event ends, so phones can be set up at the
        venue with no internet. Print the page and hand one out per phone; each works once.
      </p>
      <form onSubmit={makeHubCodes} style={{ display: "grid", gap: 8, maxWidth: 420 }}>
        <select name="gate" aria-label="Gate">
          {event.gates.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
        <select name="direction" aria-label="Role" defaultValue="entry">
          <option value="entry">Entry</option>
          <option value="exit">Exit</option>
          <option value="both">Entry and exit</option>
        </select>
        <input name="count" type="number" min={1} max={50} defaultValue={10} aria-label="Count" />
        <button type="submit">Make hub setup codes</button>
      </form>
      {hubCodes && (
        <section data-testid="hub-codes">
          <p>
            {hubCodes.qrs.length} codes for {hubCodes.gate}, valid until{" "}
            {formatTime(hubCodes.expiresAt)}. They are shown only now.{" "}
            <button type="button" onClick={() => window.print()}>
              Print
            </button>
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
            {hubCodes.qrs.map((c, i) => (
              <figure key={c.text} style={{ margin: 0, textAlign: "center" }}>
                <img src={c.png} alt={`Setup QR ${i + 1}`} width={200} height={200} />
                <figcaption>
                  {hubCodes.gate} · #{i + 1}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
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
