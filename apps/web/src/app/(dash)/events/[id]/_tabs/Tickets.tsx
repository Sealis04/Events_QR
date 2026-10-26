"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { ConfirmDialog, FormDialog } from "../../../../_components/Dialog";
import { Menu, type MenuItem } from "../../../../_components/Menu";
import { Notice } from "../../../../_components/Shell";
import { api } from "../../../../_lib/client";
import { RANK, type EventView, type Me, type TicketRow } from "../../../../_lib/types";
import { dayMonth, usePhone } from "./format";

const PAGE = 50;
type Sort = "holder" | "type" | "state" | "issued";
type State = "not_in" | "inside" | "left" | "cancelled";

const STATES: { value: State; label: string }[] = [
  { value: "not_in", label: "Not yet in" },
  { value: "inside", label: "Inside" },
  { value: "left", label: "Left" },
  { value: "cancelled", label: "Cancelled" },
];
const STATE_TONE: Record<State, string> = {
  not_in: "info",
  inside: "ok",
  left: "",
  cancelled: "bad",
};

export function stateOf(t: TicketRow): State {
  if (t.status === "cancelled") return "cancelled";
  if (t.inside) return "inside";
  return t.admits_used > 0 ? "left" : "not_in";
}

type Dialog = { kind: "transfer"; t: TicketRow } | { kind: "cancel"; t: TicketRow };

/** Ticket list: server-side search, filters, sorting and paging (50 a page), row menu with dialogs, CSV import and export. */
export function Tickets({
  event,
  me,
  refreshKey,
}: {
  event: EventView;
  me: Me;
  refreshKey: number;
}) {
  const phone = usePhone();
  const [rows, setRows] = useState<TicketRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [state, setState] = useState("");
  const [sort, setSort] = useState<Sort>("holder");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad"; text: string }>();
  const [dialog, setDialog] = useState<Dialog>();
  const hub = me.mode === "hub";
  const admin = me.role === "admin" && !hub;
  const canExport = RANK[me.role] >= RANK.supervisor && !hub;
  const type_ = (idx: number) => event.ticket_types.find((t) => t.idx === idx);
  const typeName = (idx: number) => type_(idx)?.name ?? String(idx);

  const filterParams = useCallback(() => {
    const qs = new URLSearchParams();
    if (q.trim()) qs.set("q", q.trim());
    if (type) qs.set("type", type);
    if (state) qs.set("state", state);
    return qs;
  }, [q, type, state]);

  // A change of filter or sort goes back to the first page.
  const key = `${q}|${type}|${state}|${sort}|${dir}`;
  const lastKey = useRef(key);
  const load = useCallback(
    async (p: number, append: boolean) => {
      try {
        const qs = filterParams();
        qs.set("sort", sort);
        qs.set("dir", dir);
        qs.set("limit", String(PAGE));
        qs.set("offset", String(p * PAGE));
        const res = await api<{ tickets: TicketRow[]; total?: number }>(
          `/api/events/${event.id}/tickets?${qs}`,
        );
        setRows((old) => (append ? [...old, ...res.tickets] : res.tickets));
        setTotal(res.total ?? res.tickets.length);
      } catch (err) {
        setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed to load" });
      }
    },
    [event.id, filterParams, sort, dir],
  );
  useEffect(() => {
    const changed = lastKey.current !== key;
    lastKey.current = key;
    if (changed && page !== 0) return setPage(0);
    const t = setTimeout(() => void load(page, phone && page > 0), changed ? 200 : 0);
    return () => clearTimeout(t);
  }, [key, page, phone, refreshKey]);

  const reload = () => (page === 0 ? load(0, false) : setPage(0));

  async function act(label: string, run: () => Promise<unknown>) {
    await run();
    setMsg({ tone: "ok", text: label });
    await reload();
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
      await reload();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "import failed" });
    }
  }

  function toggleSort(col: Sort) {
    if (sort === col) setDir(dir === "asc" ? "desc" : "asc");
    else {
      setSort(col);
      setDir("asc");
    }
  }
  const head = (col: Sort, label: string) => (
    <th aria-sort={sort === col ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="sort" onClick={() => toggleSort(col)}>
        {label}
        {sort === col ? (dir === "asc" ? " ↑" : " ↓") : ""}
      </button>
    </th>
  );

  const entries = (t: TicketRow): string => {
    if (t.status === "cancelled") return "–";
    const rule = type_(t.ticket_type)?.entry_rule;
    const max =
      rule?.mode === "single" ? "1" : rule?.mode === "limited" ? String(rule.max_admits) : "any";
    return `${t.admits_used} of ${max}`;
  };

  function menuFor(t: TicketRow): MenuItem[] {
    const cancelled = t.status === "cancelled";
    const adminOnly = admin ? undefined : "Admins only";
    return [
      {
        label: "View ticket and QR",
        onSelect: () => window.open(`/events/${event.id}/print?ids=${t.ticket_id}`, "_blank"),
      },
      {
        label: "Resend email",
        disabled: !admin || cancelled || !t.holder_email,
        reason: adminOnly ?? (cancelled ? "The ticket is cancelled" : "No email address on file"),
        onSelect: () =>
          void act(`Resend queued for ${t.holder_email}.`, () =>
            api(`/api/tickets/${t.ticket_id}/resend`, { body: {} }),
          ).catch((err) =>
            setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" }),
          ),
      },
      {
        label: "Transfer to someone else…",
        disabled: !admin || cancelled || t.admits_used > 0,
        reason: adminOnly ?? (cancelled ? "The ticket is cancelled" : "Already used"),
        onSelect: () => setDialog({ kind: "transfer", t }),
      },
      {
        label: "Cancel ticket…",
        danger: true,
        disabled: !admin || cancelled,
        reason: adminOnly ?? "Already cancelled",
        onSelect: () => setDialog({ kind: "cancel", t }),
      },
    ];
  }

  const holder = (t: TicketRow) => t.holder_name ?? <span className="muted">(cleared)</span>;
  const tag = (t: TicketRow) => {
    const s = stateOf(t);
    return (
      <span className={`tag ${STATE_TONE[s]}`}>{STATES.find((x) => x.value === s)!.label}</span>
    );
  };
  const exportHref = `/api/events/${event.id}/tickets/export?${filterParams()}`;
  const from = total === 0 ? 0 : page * PAGE + 1;
  const to = Math.min(total, page * PAGE + rows.length);

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, alignItems: "flex-end" }}>
        <label className="field grow" style={{ flex: "1 1 260px" }}>
          <span className="hint" style={{ position: "absolute", left: -9999 }}>
            Search tickets
          </span>
          <input
            id="ticket-search"
            type="search"
            placeholder="Search name, email, phone or ticket code"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search tickets"
          />
        </label>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
          <option value="">All types</option>
          {event.ticket_types.map((t) => (
            <option key={t.idx} value={t.idx}>
              {t.name}
            </option>
          ))}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {STATES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        {canExport && (
          <a className="btn secondary" href={exportHref}>
            Export CSV
          </a>
        )}
        {admin && (
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
        )}
      </div>
      {hub && (
        <Notice tone="warn">
          On the hub the list is read-only. Cancelling, transferring, re-sending and CSV import or
          export are done on the VM.
        </Notice>
      )}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}

      {phone ? (
        <div className="grid" data-testid="ticket-cards">
          <div className="muted small">
            {total.toLocaleString()} tickets · sorted by {sort === "holder" ? "name" : sort}
          </div>
          {rows.map((t) => (
            <div className="card ticket-card" key={t.ticket_id}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>{holder(t)}</div>
                <div className="muted small">
                  {typeName(t.ticket_type)}
                  {t.status !== "cancelled" ? ` · ${entries(t)} entries` : ""}
                </div>
              </div>
              {tag(t)}
              {!hub && (
                <Menu label={`Actions for ${t.holder_name ?? t.short_id}`} items={menuFor(t)} />
              )}
            </div>
          ))}
          {rows.length === 0 && (
            <div className="empty">
              <strong>No tickets match</strong>
              Try a different search or filter.
            </div>
          )}
          {rows.length < total && (
            <button type="button" className="secondary" onClick={() => setPage(page + 1)}>
              Show more
            </button>
          )}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table data-testid="ticket-table">
              <thead>
                <tr>
                  {head("holder", "Holder")}
                  {head("type", "Type")}
                  {head("state", "Status")}
                  <th>Entries</th>
                  {head("issued", "Issued")}
                  <th>
                    <span style={{ position: "absolute", left: -9999 }}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.ticket_id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{holder(t)}</div>
                      <div className="muted small">
                        {t.holder_email ?? t.holder_phone ?? ""} <code>{t.short_id}</code>
                      </div>
                    </td>
                    <td>{typeName(t.ticket_type)}</td>
                    <td>{tag(t)}</td>
                    <td>{entries(t)}</td>
                    <td>{dayMonth(t.issued_at, event.timezone)}</td>
                    <td>
                      {!hub && (
                        <Menu
                          label={`Actions for ${t.holder_name ?? t.short_id}`}
                          items={menuFor(t)}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div className="empty">
              <strong>No tickets match</strong>
              Try a different search or filter.
            </div>
          )}
          <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
            <span className="muted small">
              {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} tickets
            </span>
            <div className="row">
              <button
                type="button"
                className="secondary small"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="secondary small"
                disabled={(page + 1) * PAGE >= total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="muted small">
        CSV import columns: holder_name, ticket_type (index or name), holder_email, holder_phone,
        note.
      </p>

      {dialog?.kind === "transfer" && (
        <FormDialog
          title="Transfer ticket"
          submitLabel="Transfer"
          onClose={() => setDialog(undefined)}
          onSubmit={(f) =>
            act("Transferred: the old QR no longer works.", () =>
              api(`/api/tickets/${dialog.t.ticket_id}/transfer`, {
                body: {
                  holder_name: String(f.get("name")).trim(),
                  holder_email: String(f.get("email") ?? "").trim() || undefined,
                },
              }),
            )
          }
        >
          <p className="muted" style={{ margin: 0 }}>
            {dialog.t.holder_name ?? dialog.t.short_id}&apos;s QR stops working and a new ticket
            goes to the new holder.
          </p>
          <label className="field">
            New holder name
            <input name="name" required data-autofocus />
          </label>
          <label className="field">
            Their email (optional)
            <input name="email" type="email" />
          </label>
        </FormDialog>
      )}
      {dialog?.kind === "cancel" && (
        <ConfirmDialog
          title="Cancel this ticket?"
          confirmLabel="Cancel ticket"
          danger
          onClose={() => setDialog(undefined)}
          onConfirm={() =>
            act("Ticket cancelled.", () =>
              api(`/api/tickets/${dialog.t.ticket_id}/cancel`, { body: {} }),
            )
          }
        >
          <p style={{ margin: 0 }}>
            {dialog.t.holder_name ?? dialog.t.short_id}&apos;s ticket stops working at once. This
            cannot be undone.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
