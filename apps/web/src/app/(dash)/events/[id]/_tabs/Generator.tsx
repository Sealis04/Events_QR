"use client";

import { useState, type FormEvent } from "react";
import { Notice } from "../../../../_components/Shell";
import { gateMaskOf } from "../../../../_components/TypeFields";
import {
  api,
  ApiError,
  clockToMinutes,
  minutesToClock,
  SLOT_OPEN_END,
} from "../../../../_lib/client";
import { RANK, type EventView, type Issued, type Me } from "../../../../_lib/types";

interface Result extends Issued {
  emailed: string | null;
}

/** Step 2 of the spec: holder, type, contact, gates, slot, entry rule, quantity, note; QR on screen, then actions. */
export function Generator({
  event,
  me,
  onIssued,
}: {
  event: EventView;
  me: Me;
  onIssued: () => void;
}) {
  const [typeIdx, setTypeIdx] = useState(event.ticket_types[0]?.idx ?? 0);
  const type = event.ticket_types.find((t) => t.idx === typeIdx);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState("");
  const [soldOut, setSoldOut] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [restrict, setRestrict] = useState(false);
  const [gates, setGates] = useState<boolean[]>(event.gates.map(() => false));
  const [slotChoice, setSlotChoice] = useState("none");
  const [rule, setRule] = useState("default");
  const [emailTo, setEmailTo] = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const canOverrideRule = RANK[me.role] >= RANK.supervisor;

  async function generate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError("");
    setSoldOut(undefined);
    const quantity = Number(f.get("quantity") || 1);
    const name = String(f.get("name") ?? "").trim();
    if (quantity === 1 && !name) return setError("Holder name is required for a single ticket.");

    const body: Record<string, unknown> = {
      idempotency_key: crypto.randomUUID(),
      ticket_type: typeIdx,
      quantity,
      holder_name: name || undefined,
      holder_email: String(f.get("email") ?? "").trim() || undefined,
      holder_phone: String(f.get("phone") ?? "").trim() || undefined,
      note: String(f.get("note") ?? "").trim() || undefined,
    };
    if (restrict) body.gate_mask = gateMaskOf(gates);
    if (slotChoice.startsWith("type:")) {
      const s = type?.slots[Number(slotChoice.slice(5))];
      if (s) body.slot = { start: s.start, end: s.end };
    } else if (slotChoice === "custom") {
      const start = clockToMinutes(String(f.get("slotStart")));
      const endText = String(f.get("slotEnd") ?? "").trim();
      const end = endText === "" ? SLOT_OPEN_END : clockToMinutes(endText);
      if (start === undefined || end === undefined || (end !== SLOT_OPEN_END && end <= start))
        return setError("Custom slot: start must be before end (HH:MM).");
      body.slot = { start, end };
    }
    if (rule !== "default") {
      body.entry_rule =
        rule === "limited"
          ? { mode: "limited", max_admits: Number(f.get("ruleMax") || 2) }
          : { mode: rule };
    }

    setBusy(true);
    try {
      const res = await api<{ tickets: Issued[] }>(`/api/events/${event.id}/tickets`, { body });
      const emailed = body.holder_email ? String(body.holder_email) : null;
      setResults(res.tickets.map((t) => ({ ...t, emailed })));
      setEmailMsg("");
      onIssued();
    } catch (err) {
      if (err instanceof ApiError && err.code === "sold_out") {
        const remaining = (err.details as { remaining?: number | null } | undefined)?.remaining;
        setSoldOut(
          remaining === undefined || remaining === null
            ? `${type?.name ?? "This ticket type"} is sold out.`
            : `${type?.name ?? "This ticket type"} has only ${remaining} left; you asked for ${quantity}.`,
        );
      } else setError(err instanceof Error ? err.message : "failed to generate");
    } finally {
      setBusy(false);
    }
  }

  async function sendEmail() {
    const first = results[0];
    if (!first) return;
    try {
      for (const t of results)
        await api(`/api/tickets/${t.ticket_id}/resend`, { body: { email: emailTo } });
      setEmailMsg(`Queued for ${emailTo}.`);
    } catch (err) {
      setEmailMsg(err instanceof Error ? err.message : "could not queue the email");
    }
  }

  const ids = results.map((r) => r.ticket_id).join(",");
  return (
    <div className="cols" style={{ alignItems: "start" }}>
      <form className="card grid" onSubmit={generate} aria-label="Generate tickets">
        <label className="field">
          Ticket type
          <select
            value={typeIdx}
            onChange={(e) => {
              setTypeIdx(Number(e.target.value));
              setSlotChoice("none");
            }}
            aria-label="Ticket type"
          >
            {event.ticket_types.map((t) => (
              <option key={t.idx} value={t.idx}>
                {t.name}
                {t.capacity !== null ? ` (${Math.max(0, t.capacity - t.issued)} left)` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Holder name
          <input
            name="name"
            aria-label="Holder name"
            placeholder="Blank for numbered names in a batch"
          />
        </label>
        <div className="cols">
          <label className="field">
            Email (optional, sends the ticket)
            <input name="email" type="email" aria-label="Email" />
          </label>
          <label className="field">
            Phone (optional)
            <input name="phone" type="tel" aria-label="Phone" />
          </label>
        </div>
        <label className="field">
          Quantity
          <input
            name="quantity"
            type="number"
            min={1}
            max={500}
            defaultValue={1}
            aria-label="Quantity"
          />
        </label>
        <label className="row">
          <input
            type="checkbox"
            checked={restrict}
            onChange={(e) => setRestrict(e.target.checked)}
          />
          Restrict to certain gates (default: the ticket type&apos;s gates)
        </label>
        {restrict && (
          <div className="row">
            {event.gates.map((g, i) => (
              <label key={g} className="row">
                <input
                  type="checkbox"
                  checked={gates[i]}
                  onChange={(e) => setGates(gates.map((x, j) => (j === i ? e.target.checked : x)))}
                />
                {g}
              </label>
            ))}
          </div>
        )}
        <label className="field">
          Time slot
          <select
            value={slotChoice}
            onChange={(e) => setSlotChoice(e.target.value)}
            aria-label="Time slot"
          >
            <option value="none">No slot</option>
            {type?.slots.map((s, i) => (
              <option key={i} value={`type:${i}`}>
                {minutesToClock(s.start)}–
                {s.end === SLOT_OPEN_END ? "end of event" : minutesToClock(s.end)}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {slotChoice === "custom" && (
          <div className="row">
            <input name="slotStart" placeholder="Start 18:00" aria-label="Slot start" size={10} />
            <input
              name="slotEnd"
              placeholder="End 22:00 (blank = event end)"
              aria-label="Slot end"
              size={24}
            />
          </div>
        )}
        {canOverrideRule && (
          <div className="row">
            <label className="field">
              Entry rule (supervisor override)
              <select
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                aria-label="Entry rule override"
              >
                <option value="default">Ticket type&apos;s rule</option>
                <option value="single">Single entry</option>
                <option value="unlimited">Unlimited re-entry</option>
                <option value="limited">Up to N entries</option>
              </select>
            </label>
            {rule === "limited" && (
              <input
                name="ruleMax"
                type="number"
                min={2}
                max={63}
                defaultValue={3}
                aria-label="Override N"
              />
            )}
          </div>
        )}
        <label className="field">
          Internal note
          <input name="note" aria-label="Note" />
        </label>
        {soldOut && <Notice tone="bad">Sold out: {soldOut}</Notice>}
        {error && <Notice tone="bad">{error}</Notice>}
        <button type="submit" disabled={busy || !type}>
          {busy ? "Generating…" : "Generate"}
        </button>
      </form>

      <div>
        {results.length > 0 && (
          <section className="card" data-testid="issued">
            <h2>{results.length === 1 ? "Ticket ready" : `${results.length} tickets ready`}</h2>
            <div className="qr-grid">
              {results.map((t) => (
                <figure key={t.ticket_id}>
                  <img
                    src={t.qr_png}
                    alt={`QR for ${t.holder_name ?? t.short_id}`}
                    width={results.length === 1 ? 260 : 150}
                    height={results.length === 1 ? 260 : 150}
                  />
                  <figcaption>
                    {t.holder_name}
                    <br />
                    <code data-testid="short-id">{t.short_id}</code>
                    <br />
                    <a download={`ticket-${t.short_id}.png`} href={t.qr_png}>
                      Download PNG
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <a
                className="btn"
                href={`/events/${event.id}/print?ids=${ids}`}
                target="_blank"
                rel="noreferrer"
              >
                Print / PDF
              </a>
              <button
                className="secondary"
                onClick={() => {
                  setResults([]);
                  setError("");
                }}
              >
                Generate another
              </button>
            </div>
            <div style={{ marginTop: 12 }}>
              {results[0]?.emailed ? (
                <Notice tone="ok">Email queued to {results[0].emailed}.</Notice>
              ) : me.role === "admin" ? (
                <div className="row">
                  <input
                    type="email"
                    placeholder="Email address"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    aria-label="Send by email to"
                  />
                  <button className="secondary" disabled={!emailTo} onClick={sendEmail}>
                    Email
                  </button>
                  {emailMsg && <span className="muted">{emailMsg}</span>}
                </div>
              ) : (
                <p className="muted">
                  To email a ticket, type the address before pressing Generate.
                </p>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
