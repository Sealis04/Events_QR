"use client";

import { useCallback, useEffect, useState } from "react";
import { FormDialog } from "../../../../_components/Dialog";
import { Notice } from "../../../../_components/Shell";
import { api } from "../../../../_lib/client";
import type { EventView, TicketRow } from "../../../../_lib/types";
import { dayMonth, hhmm } from "./format";

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
  const [asking, setAsking] = useState<TicketRow>();
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

  async function admit(t: TicketRow, pin: string) {
    const res = await api<{ result: string }>(`/api/events/${event.id}/admit`, {
      body: { ticket_id: t.ticket_id, pin },
    });
    setMsg({
      tone: res.result === "admitted" ? "ok" : "warn",
      text: `${t.holder_name ?? t.short_id}: ${verdict[res.result] ?? res.result}`,
    });
    await Promise.all([search(), loadAudit()]);
  }

  const stateTag = (t: TicketRow) =>
    t.status === "cancelled" ? (
      <span className="tag bad">Cancelled</span>
    ) : t.inside ? (
      <span className="tag ok">Inside</span>
    ) : t.admits_used > 0 ? (
      <span className="tag">Left</span>
    ) : (
      <span className="tag info">Not yet in</span>
    );
  const searching = q.trim().length >= 2;

  return (
    <div>
      <div className="card">
        <h2>Find an attendee</h2>
        <input
          type="search"
          placeholder="Name, email or last 6 characters of the ticket id"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find an attendee"
          style={{ width: "100%" }}
        />
        {msg && (
          <div style={{ marginTop: 10 }}>
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
        {!searching && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Type at least 2 characters to search. Admitting someone by hand asks for your PIN again
            and is logged as an override.
          </p>
        )}
        {searching && rows.length === 0 && (
          <div className="empty">
            <strong>No match</strong>
            Check the spelling, or try the last 6 characters of the ticket id.
          </div>
        )}
        {rows.length > 0 && (
          <div className="table-wrap">
            <table data-testid="attendees">
              <tbody>
                {rows.map((t) => (
                  <tr key={t.ticket_id}>
                    <td>
                      <strong>{t.holder_name ?? "(cleared)"}</strong>
                      <br />
                      <span className="muted small">
                        {typeName(t.ticket_type)} · <code>{t.short_id}</code>
                      </span>
                    </td>
                    <td>
                      {stateTag(t)}
                      <br />
                      <span className="muted small">{t.admits_used} admits</span>
                    </td>
                    <td className="num">
                      <button disabled={t.status === "cancelled"} onClick={() => setAsking(t)}>
                        Admit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Overrides by staff</h2>
        {audit && audit.overrides.length === 0 ? (
          <div className="empty">
            <strong>No overrides yet</strong>
            Manual admits and supervisor overrides will be listed here.
          </div>
        ) : (
          <>
            <div className="chips" style={{ marginBottom: 10 }}>
              {audit?.by_staff.map((s) => (
                <span className="tag-chip" key={s.staff_id ?? "none"}>
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
                      <td>
                        {dayMonth(o.scanned_at, event.timezone)}{" "}
                        {hhmm(o.scanned_at, event.timezone)}
                      </td>
                      <td>{o.holder_name ?? o.ticket_id.slice(-6).toUpperCase()}</td>
                      <td>{o.staff_name ?? "—"}</td>
                      <td>{o.gate}</td>
                      <td>{o.offline ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {asking && (
        <FormDialog
          title={`Admit ${asking.holder_name ?? asking.short_id}?`}
          submitLabel="Confirm admit"
          onClose={() => setAsking(undefined)}
          onSubmit={(f) => admit(asking, String(f.get("pin")))}
        >
          <p className="muted" style={{ margin: 0 }}>
            Enter your PIN again. This is logged as an override.
          </p>
          <label className="field">
            Your PIN
            <input
              name="pin"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              required
              data-autofocus
              aria-label="Supervisor PIN"
            />
          </label>
        </FormDialog>
      )}
    </div>
  );
}
