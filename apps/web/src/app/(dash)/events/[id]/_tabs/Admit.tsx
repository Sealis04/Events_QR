"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Notice } from "../../../../_components/Shell";
import { api, formatTime } from "../../../../_lib/client";
import type { EventView, TicketRow } from "../../../../_lib/types";

interface Override {
  scan_id: string;
  ticket_id: string;
  holder_name: string | null;
  staff_name: string | null;
  gate: string;
  scanned_at: number;
  offline: boolean;
}
interface Audit {
  overrides: Override[];
  by_staff: { staff_id: string | null; staff_name: string | null; count: number }[];
}

const verdict: Record<string, string> = {
  admitted: "Admitted (logged as an override).",
  rejected_inside: "Not admitted: the holder is already inside.",
  rejected_used: "Not admitted: the ticket is used up.",
  rejected_cancelled: "Not admitted: the ticket is cancelled.",
};

/** Attendee search with manual admit (the supervisor's PIN again, logged as `override`), and the audit of overrides by staff. */
export function Admit({ event }: { event: EventView }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [asking, setAsking] = useState<string>();
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string }>();
  const [audit, setAudit] = useState<Audit>();
  const typeName = (idx: number) =>
    event.ticket_types.find((t) => t.idx === idx)?.name ?? String(idx);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await api<Audit>(`/api/events/${event.id}/overrides`));
    } catch {
      // the audit is a nicety next to the search
    }
  }, [event.id]);
  useEffect(() => void loadAudit(), [loadAudit]);

  const search = useCallback(async () => {
    if (q.trim().length < 2) return setRows([]);
    try {
      const res = await api<{ tickets: TicketRow[] }>(
        `/api/events/${event.id}/tickets?${new URLSearchParams({ q: q.trim(), limit: "30" })}`,
      );
      setRows(res.tickets);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "search failed" });
    }
  }, [event.id, q]);
  useEffect(() => {
    const t = setTimeout(() => void search(), 250);
    return () => clearTimeout(t);
  }, [search]);

  async function admit(e: FormEvent<HTMLFormElement>, t: TicketRow) {
    e.preventDefault();
    const pin = String(new FormData(e.currentTarget).get("pin"));
    try {
      const res = await api<{ result: string }>(`/api/events/${event.id}/admit`, {
        body: { ticket_id: t.ticket_id, pin },
      });
      setMsg({
        tone: res.result === "admitted" ? "ok" : "warn",
        text: `${t.holder_name ?? t.short_id}: ${verdict[res.result] ?? res.result}`,
      });
      setAsking(undefined);
      await Promise.all([search(), loadAudit()]);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });
    }
  }

  return (
    <div>
      <div className="card">
        <h3>Find an attendee</h3>
        <input
          type="search"
          placeholder="Name, email or last 6 characters of the ticket id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find an attendee"
          size={44}
        />
        {msg && (
          <div style={{ marginTop: 10 }}>
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
        <div className="table-wrap">
          <table data-testid="attendees">
            <tbody>
              {rows.map((t) => (
                <tr key={t.ticket_id}>
                  <td>
                    <strong>{t.holder_name ?? "(cleared)"}</strong>
                    <br />
                    <span className="muted">
                      {typeName(t.ticket_type)} · <code>{t.short_id}</code>
                    </span>
                  </td>
                  <td>
                    <span
                      className={`pill ${t.status === "cancelled" ? "bad" : t.inside ? "warn" : "ok"}`}
                    >
                      {t.status === "cancelled"
                        ? "cancelled"
                        : t.inside
                          ? "inside"
                          : t.status.replace("_", " ")}
                    </span>
                    <br />
                    <span className="muted">{t.admits_used} admits</span>
                  </td>
                  <td>
                    {asking === t.ticket_id ? (
                      <form className="row" onSubmit={(e) => admit(e, t)}>
                        <input
                          name="pin"
                          type="password"
                          placeholder="Your PIN"
                          autoComplete="current-password"
                          required
                          autoFocus
                          aria-label="Supervisor PIN"
                        />
                        <button type="submit">Confirm admit</button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setAsking(undefined)}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        disabled={t.status === "cancelled"}
                        onClick={() => setAsking(t.ticket_id)}
                      >
                        Admit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {q.trim().length >= 2 && rows.length === 0 && <p className="muted">No match.</p>}
      </div>

      <div className="card">
        <h3>Overrides by staff</h3>
        {audit && audit.by_staff.length === 0 && <p className="muted">No overrides yet.</p>}
        <div className="row">
          {audit?.by_staff.map((s) => (
            <span className="pill" key={s.staff_id ?? "none"}>
              {s.staff_name ?? "unknown"}: {s.count}
            </span>
          ))}
        </div>
        <div className="table-wrap">
          <table data-testid="overrides">
            <thead>
              <tr>
                <th>When</th>
                <th>Attendee</th>
                <th>By</th>
                <th>Gate</th>
                <th>Offline</th>
              </tr>
            </thead>
            <tbody>
              {audit?.overrides.map((o) => (
                <tr key={o.scan_id}>
                  <td>{formatTime(o.scanned_at)}</td>
                  <td>{o.holder_name ?? o.ticket_id.slice(-6).toUpperCase()}</td>
                  <td>{o.staff_name ?? "—"}</td>
                  <td>{o.gate}</td>
                  <td>{o.offline ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
