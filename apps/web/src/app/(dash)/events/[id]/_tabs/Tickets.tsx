"use client";

import { useCallback, useEffect, useState, type ChangeEvent } from "react";
import { Notice } from "../../../../_components/Shell";
import { api, formatTime } from "../../../../_lib/client";
import { RANK, type EventView, type Me, type TicketRow } from "../../../../_lib/types";

const statusTone = { valid: "ok", used_up: "warn", cancelled: "bad" } as const;

/** Ticket list with search (name, email, phone or last 6 hex), status filter, cancel / transfer / re-send, CSV import and export. */
export function Tickets({
  event,
  me,
  refreshKey,
}: {
  event: EventView;
  me: Me;
  refreshKey: number;
}) {
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string }>();
  const hub = me.mode === "hub";
  const admin = me.role === "admin" && !hub;
  const typeName = (idx: number) =>
    event.ticket_types.find((t) => t.idx === idx)?.name ?? String(idx);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ limit: "200" });
      if (q.trim()) qs.set("q", q.trim());
      if (status) qs.set("status", status);
      const res = await api<{ tickets: TicketRow[]; total?: number }>(
        `/api/events/${event.id}/tickets?${qs}`,
      );
      setRows(res.tickets);
      setTotal(res.total ?? res.tickets.length);
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load" });
    }
  }, [event.id, q, status]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [load, refreshKey]);

  async function act(label: string, run: () => Promise<unknown>) {
    try {
      await run();
      setMsg({ tone: "ok", text: label });
      await load();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });
    }
  }

  async function importCsv(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const res = await api<{ created: number; errors: { row: number; message: string }[] }>(
        `/api/events/${event.id}/tickets/import`,
        { body: { csv: await file.text(), idempotency_key: crypto.randomUUID() } },
      );
      setMsg({
        tone: res.errors.length ? "bad" : "ok",
        text: `Imported ${res.created} tickets.${
          res.errors.length
            ? ` ${res.errors.length} rows failed: ${res.errors
                .slice(0, 5)
                .map((x) => `row ${x.row}: ${x.message}`)
                .join("; ")}`
            : ""
        }`,
      });
      await load();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "import failed" });
    }
  }

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <input
          type="search"
          placeholder="Name, email, phone or last 6 characters"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search tickets"
          size={34}
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Status filter"
        >
          <option value="">Any status</option>
          <option value="valid">Valid</option>
          <option value="used_up">Used up</option>
          <option value="cancelled">Cancelled</option>
        </select>
        <span className="muted">
          {rows.length} of {total}
        </span>
        {admin && (
          <>
            <label className="btn secondary" style={{ cursor: "pointer" }}>
              Import CSV
              <input
                type="file"
                accept=".csv,text/csv"
                hidden
                onChange={importCsv}
                aria-label="Import CSV"
              />
            </label>
            <a className="btn secondary" href={`/api/events/${event.id}/tickets/export`}>
              Export CSV
            </a>
          </>
        )}
      </div>
      {hub && (
        <Notice tone="warn">
          On the hub the list is read-only. Cancelling, transferring, re-sending and CSV import or
          export are done on the VM.
        </Notice>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="table-wrap">
        <table data-testid="ticket-table">
          <thead>
            <tr>
              <th>Holder</th>
              <th>Contact</th>
              <th>Type</th>
              <th>Status</th>
              <th>Admits</th>
              <th>Inside</th>
              <th>ID</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.ticket_id}>
                <td>{t.holder_name ?? <span className="muted">(cleared)</span>}</td>
                <td>
                  {t.holder_email ?? ""}
                  {t.holder_email && t.holder_phone ? <br /> : null}
                  {t.holder_phone ?? ""}
                </td>
                <td>{typeName(t.ticket_type)}</td>
                <td>
                  <span className={`pill ${statusTone[t.status]}`}>
                    {t.status.replace("_", " ")}
                  </span>
                </td>
                <td>{t.admits_used}</td>
                <td>{t.inside ? "yes" : "no"}</td>
                <td>
                  <code>{t.short_id}</code>
                </td>
                <td>
                  <div className="row">
                    {!hub && (
                      <a
                        href={`/events/${event.id}/print?ids=${t.ticket_id}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        QR
                      </a>
                    )}
                    {admin && t.status !== "cancelled" && (
                      <>
                        <button
                          className="secondary"
                          disabled={!t.holder_email}
                          title={
                            t.holder_email ? "Send the same QR again" : "No email address on file"
                          }
                          onClick={() =>
                            act(`Re-send queued for ${t.holder_email}.`, () =>
                              api(`/api/tickets/${t.ticket_id}/resend`, { body: {} }),
                            )
                          }
                        >
                          Re-send
                        </button>
                        <button
                          className="secondary"
                          disabled={t.admits_used > 0}
                          onClick={() => {
                            const name = window.prompt("Transfer to (new holder name)?");
                            if (!name) return;
                            const email = window.prompt("Their email (optional)?") || undefined;
                            void act("Transferred: the old QR no longer works.", () =>
                              api(`/api/tickets/${t.ticket_id}/transfer`, {
                                body: { holder_name: name, holder_email: email },
                              }),
                            );
                          }}
                        >
                          Transfer
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            if (
                              window.confirm(
                                `Cancel ${t.holder_name ?? t.short_id}'s ticket? Its QR stops working.`,
                              )
                            )
                              void act("Ticket cancelled.", () =>
                                api(`/api/tickets/${t.ticket_id}/cancel`, { body: {} }),
                              );
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="muted">No tickets match.</p>}
      {RANK[me.role] < RANK.admin && !hub && (
        <p className="muted">Cancelling, transferring, importing and exporting are for admins.</p>
      )}
      <p className="muted">
        Last updated {formatTime(Math.floor(Date.now() / 1000))}. CSV import columns: holder_name,
        ticket_type (index or name), holder_email, holder_phone, note.
      </p>
    </div>
  );
}
