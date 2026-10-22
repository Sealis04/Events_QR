"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Notice } from "../../../../_components/Shell";
import { ago, api, formatTime } from "../../../../_lib/client";
import type { EventView, Me } from "../../../../_lib/types";

interface Device {
  id: string;
  kind: "scanner" | "hub";
  label: string | null;
  gate: string;
  direction: "entry" | "exit" | "both";
  revoked: boolean;
  last_seen_at: number | null;
  outbox_size: number | null;
  battery_pct: number | null;
  last_scan_at: number | null;
}
interface Panel {
  devices: Device[];
  server_time: number;
}
interface Codes {
  qrs: { text: string; png: string }[];
  expiresAt: number;
  gate: string;
  title: string;
}

/** Offline, or not seen for more than 2 minutes, is highlighted. */
export function connection(
  d: Device,
  now: number,
): { label: string; tone: "ok" | "warn" | "bad"; hot: boolean } {
  if (d.revoked) return { label: "Revoked", tone: "bad", hot: false };
  if (d.last_seen_at === null) return { label: "Never seen", tone: "bad", hot: true };
  const age = now - d.last_seen_at;
  if (age <= 60) return { label: "Online", tone: "ok", hot: false };
  if (age <= 120) return { label: "Quiet", tone: "warn", hot: false };
  return { label: "Offline", tone: "bad", hot: true };
}

const directionLabel = { entry: "Entry", exit: "Exit", both: "Entry and exit" } as const;

export function Devices({ event, me }: { event: EventView; me: Me }) {
  const hub = me.mode === "hub";
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string }>();
  const [codes, setCodes] = useState<Codes>();
  const [edit, setEdit] = useState<{ id: string; gate: string; direction: Device["direction"] }>();

  const load = useCallback(async () => {
    try {
      setPanel(await api<Panel>(`/api/events/${event.id}/devices`));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [event.id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function run(okText: string, fn: () => Promise<unknown>) {
    try {
      await fn();
      setMsg({ tone: "ok", text: okText });
      await load();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });
    }
  }

  async function revoke(d: Device, rotate: boolean) {
    const name = d.label ?? d.id.slice(0, 8);
    const ok = window.confirm(
      rotate
        ? `Revoke ${name} and rotate PINs?\n\nThe phone stops working at once. Everyone who works this event (and anyone removed from it) must choose a new PIN at their next login, and their old PIN hashes stop going to phones until they do. Use this when the phone is lost.`
        : `Revoke ${name}? The phone stops working and wipes itself the next time it is online.`,
    );
    if (!ok) return;
    try {
      const res = await api<{ rotated_staff: { name: string }[] }>(`/api/devices/${d.id}/revoke`, {
        body: { rotate },
      });
      setMsg({
        tone: rotate ? "warn" : "ok",
        text: rotate
          ? `${name} revoked. ${res.rotated_staff.length} people must now choose a new PIN: ${res.rotated_staff.map((s) => s.name).join(", ") || "nobody"}. That includes you if you are on the list.`
          : `${name} revoked.`,
      });
      await load();
    } catch (err) {
      setMsg({ tone: "bad", text: err instanceof Error ? err.message : "failed" });
    }
  }

  async function makeCodes(e: FormEvent<HTMLFormElement>, forHub: boolean) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const gate = String(f.get("gate"));
    try {
      const res = await api<{ setup_qrs: string[]; expires_at: number }>("/api/devices/enroll", {
        body: {
          event_id: event.id,
          gate,
          direction: String(f.get("direction")),
          label: String(f.get("label") ?? "").trim() || undefined,
          ...(forHub ? { count: Number(f.get("count") || 10), for_hub: true } : {}),
        },
      });
      const qrs = await Promise.all(
        res.setup_qrs.map(async (text) => ({
          text,
          png: await QRCode.toDataURL(text, { errorCorrectionLevel: "M", margin: 4, scale: 6 }),
        })),
      );
      setCodes({
        qrs,
        expiresAt: res.expires_at,
        gate,
        title: forHub ? "Hub setup codes" : "Scanner setup code",
      });
      setMsg(undefined);
    } catch (err) {
      setMsg({
        tone: "bad",
        text: err instanceof Error ? err.message : "failed to make a setup code",
      });
    }
  }

  const now = panel?.server_time ?? Math.floor(Date.now() / 1000);
  return (
    <div>
      {hub && (
        <Notice tone="warn">
          On the hub the panel is read-only. Moving, revoking and setting up phones is done on the
          VM.
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="card">
        <div className="table-wrap">
          <table data-testid="device-table">
            <thead>
              <tr>
                <th>Device</th>
                <th>Gate · role</th>
                <th>Connection</th>
                <th>Last seen</th>
                <th>Outbox</th>
                <th>Battery</th>
                <th>Last scan</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {panel?.devices.map((d) => {
                const c = connection(d, now);
                const editing = edit?.id === d.id;
                return (
                  <tr
                    key={d.id}
                    className={c.hot ? "hot" : ""}
                    data-testid={`device-${d.label ?? d.id}`}
                    data-state={c.label}
                  >
                    <td>
                      {d.kind === "hub" ? "Hub" : (d.label ?? <code>{d.id.slice(0, 8)}</code>)}
                    </td>
                    <td>
                      {editing ? (
                        <div className="row">
                          <select
                            value={edit.gate}
                            onChange={(e) => setEdit({ ...edit, gate: e.target.value })}
                            aria-label="Gate"
                          >
                            {event.gates.map((g) => (
                              <option key={g}>{g}</option>
                            ))}
                          </select>
                          <select
                            value={edit.direction}
                            onChange={(e) =>
                              setEdit({ ...edit, direction: e.target.value as Device["direction"] })
                            }
                            aria-label="Role"
                          >
                            <option value="entry">Entry</option>
                            <option value="exit">Exit</option>
                            <option value="both">Entry and exit</option>
                          </select>
                        </div>
                      ) : d.kind === "hub" ? (
                        "—"
                      ) : (
                        `${d.gate} · ${directionLabel[d.direction]}`
                      )}
                    </td>
                    <td>
                      <span className={`pill ${c.tone}`}>{c.label}</span>
                    </td>
                    <td>{ago(d.last_seen_at, now)}</td>
                    <td>{d.outbox_size ?? "—"}</td>
                    <td>{d.battery_pct === null ? "" : `${d.battery_pct}%`}</td>
                    <td>{d.last_scan_at ? formatTime(d.last_scan_at) : "—"}</td>
                    <td>
                      {!hub && d.kind === "scanner" && !d.revoked && (
                        <div className="row">
                          {editing ? (
                            <>
                              <button
                                onClick={() =>
                                  run("Moved. The phone picks it up at its next sync.", () =>
                                    api(`/api/devices/${d.id}`, {
                                      method: "PATCH",
                                      body: { gate: edit.gate, direction: edit.direction },
                                    }),
                                  ).then(() => setEdit(undefined))
                                }
                              >
                                Save
                              </button>
                              <button className="secondary" onClick={() => setEdit(undefined)}>
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              className="secondary"
                              onClick={() =>
                                setEdit({ id: d.id, gate: d.gate, direction: d.direction })
                              }
                            >
                              Move
                            </button>
                          )}
                          <button className="secondary" onClick={() => revoke(d, false)}>
                            Revoke
                          </button>
                          <button className="danger" onClick={() => revoke(d, true)}>
                            Revoke and rotate
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {panel?.devices.length === 0 && <p className="muted">No devices yet.</p>}
        <p className="muted">
          Highlighted rows are offline or have not been seen for over 2 minutes. Battery shows only
          for phones whose browser reports it.
        </p>
      </div>

      {!hub && (
        <div className="cols">
          <form
            className="card grid"
            onSubmit={(e) => makeCodes(e, false)}
            aria-label="Add scanner"
          >
            <h3>Add a scanner</h3>
            <p className="muted">
              A one-time setup QR, valid for 10 minutes. Scan it from the phone&apos;s scanner page.
            </p>
            <label className="field">
              Gate
              <select name="gate" aria-label="Gate">
                {event.gates.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Role
              <select name="direction" defaultValue="entry" aria-label="Role">
                <option value="entry">Entry</option>
                <option value="exit">Exit</option>
                <option value="both">Entry and exit</option>
              </select>
            </label>
            <label className="field">
              Label (optional)
              <input name="label" aria-label="Label" />
            </label>
            <button type="submit">Show setup QR</button>
          </form>
          <form
            className="card grid"
            onSubmit={(e) => makeCodes(e, true)}
            aria-label="Hub setup codes"
          >
            <h3>Batch codes for the venue hub</h3>
            <p className="muted">
              Single-use setup QRs that stay valid until the event ends, so phones can be set up at
              the venue with no internet.
            </p>
            <label className="field">
              Gate
              <select name="gate" aria-label="Gate">
                {event.gates.map((g) => (
                  <option key={g}>{g}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Role
              <select name="direction" defaultValue="entry" aria-label="Role">
                <option value="entry">Entry</option>
                <option value="exit">Exit</option>
                <option value="both">Entry and exit</option>
              </select>
            </label>
            <label className="field">
              How many
              <input
                name="count"
                type="number"
                min={1}
                max={50}
                defaultValue={10}
                aria-label="Count"
              />
            </label>
            <button type="submit">Make hub setup codes</button>
          </form>
        </div>
      )}
      {codes && (
        <section className="card" data-testid="setup-codes">
          <h3>{codes.title}</h3>
          <p>
            {codes.qrs.length} code{codes.qrs.length === 1 ? "" : "s"} for {codes.gate}, valid until{" "}
            {formatTime(codes.expiresAt)}. They are shown only now.{" "}
            <button type="button" className="secondary" onClick={() => window.print()}>
              Print
            </button>
          </p>
          <div className="qr-grid">
            {codes.qrs.map((c, i) => (
              <figure key={c.text}>
                <img src={c.png} alt={`Setup QR ${i + 1}`} width={200} height={200} />
                <figcaption>
                  {codes.gate} · #{i + 1}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
