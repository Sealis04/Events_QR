"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useState } from "react";
import { Dialog, FormDialog } from "../../../../_components/Dialog";
import { Menu } from "../../../../_components/Menu";
import { Notice } from "../../../../_components/Shell";
import { api, formatTime } from "../../../../_lib/client";
import type { EventView, Me } from "../../../../_lib/types";
import { hhmm, usePhone } from "./format";

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

/** Online up to 90 s since the last contact, Quiet up to 10 min, then Offline (highlighted). */
export function connection(
  d: Device,
  now: number,
): { label: string; detail: string; tone: "ok" | "warn" | "bad"; hot: boolean; tip?: string } {
  if (d.revoked) return { label: "Revoked", detail: "Revoked", tone: "bad", hot: false };
  if (d.last_seen_at === null)
    return { label: "Never seen", detail: "Never seen", tone: "bad", hot: true };
  const age = Math.max(0, now - d.last_seen_at);
  const min = Math.floor(age / 60);
  const tip = `No scans or check-ins for ${min} minute${min === 1 ? "" : "s"}`;
  if (age <= 90) return { label: "Online", detail: "Online", tone: "ok", hot: false };
  if (age <= 600)
    return {
      label: "Quiet",
      detail: `Quiet · no contact for ${min} min`,
      tone: "warn",
      hot: false,
      tip,
    };
  return {
    label: "Offline",
    detail: `Offline · no contact for ${min} min`,
    tone: "bad",
    hot: true,
    tip,
  };
}

const directionLabel = { entry: "Entry", exit: "Exit", both: "Entry and exit" } as const;

interface RevokePreview {
  label: string | null;
  outbox_size: number | null;
  rotate_staff: { id: string; name: string }[];
}

/** The revoke box: says what happens, how many scans wait on the phone, and (when lost or stolen) who must pick a new PIN. */
function RevokeDialog({
  device,
  me,
  onClose,
  onDone,
}: {
  device: Device;
  me: Me;
  onClose: () => void;
  onDone: (tone: "ok" | "warn", text: string) => void;
}) {
  const isHub = device.kind === "hub";
  const name = isHub ? "the hub" : (device.label ?? device.id.slice(0, 8));
  const [preview, setPreview] = useState<RevokePreview>();
  const [lost, setLost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api<RevokePreview>(`/api/devices/${device.id}/revoke`)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load"));
  }, [device.id]);
  const waiting = preview?.outbox_size ?? device.outbox_size ?? 0;
  const people = preview?.rotate_staff ?? [];
  const includesMe = people.some((p) => p.id === me.id);

  async function go() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ rotated_staff: { name: string }[] }>(
        `/api/devices/${device.id}/revoke`,
        {
          body: lost ? { rotate: true } : {},
        },
      );
      onDone(
        lost ? "warn" : "ok",
        lost
          ? `${name} revoked. ${res.rotated_staff.length} ${res.rotated_staff.length === 1 ? "person" : "people"} must now choose a new PIN: ${res.rotated_staff.map((s) => s.name).join(", ") || "nobody"}.${includesMe ? " That includes you." : ""}`
          : `${name} revoked.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={`Revoke ${name}?`}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose} data-autofocus>
            Keep it
          </button>
          <button type="button" className="danger" onClick={go} disabled={busy || !preview}>
            Revoke {name}
          </button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        {isHub
          ? "It stops syncing with this server at once. Do this for a hub that was reset without reaching the server."
          : `It stops scanning at once and erases itself the next time it is online. ${
              waiting > 0
                ? `Its ${waiting} waiting scan${waiting === 1 ? "" : "s"} upload first if it comes back.`
                : "It has no scans waiting to upload."
            }`}
      </p>
      <label className="check" style={{ alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={lost}
          onChange={(e) => setLost(e.target.checked)}
          style={{ marginTop: 10 }}
        />
        <span>
          <strong>This {isHub ? "hub" : "phone"} was lost or stolen</strong>
          <br />
          <span className="hint">
            Everyone who can log in on this event
            {preview
              ? ` (${people.length} ${people.length === 1 ? "person" : "people"}${includesMe ? ", including you" : ""})`
              : ""}{" "}
            will have to choose a new PIN. Only tick this if the {isHub ? "hub" : "phone"} is out of
            your hands.
          </span>
        </span>
      </label>
      {lost && preview && (
        <div className="notice warn" style={{ margin: 0 }} data-testid="rotate-list">
          Will have to choose a new PIN: {people.map((p) => p.name).join(", ") || "nobody"}.
        </div>
      )}
      {error && (
        <div role="alert" className="notice bad" style={{ margin: 0 }}>
          {error}
        </div>
      )}
    </Dialog>
  );
}

export function Devices({ event, me }: { event: EventView; me: Me }) {
  const hub = me.mode === "hub";
  const phone = usePhone();
  const [panel, setPanel] = useState<Panel>();
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "bad" | "warn"; text: string }>();
  const [codes, setCodes] = useState<Codes>();
  const [dialog, setDialog] = useState<
    { kind: "setup" | "hubcodes" } | { kind: "move" | "revoke"; d: Device }
  >();

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

  async function makeCodes(f: FormData, forHub: boolean) {
    const gate = String(f.get("gate"));
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
  }

  const gateAndRole = (d?: Device) => (
    <>
      <label className="field">
        Gate
        <select name="gate" aria-label="Gate" defaultValue={d?.gate}>
          {event.gates.map((g) => (
            <option key={g}>{g}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Role
        <select name="direction" defaultValue={d?.direction ?? "entry"} aria-label="Role">
          <option value="entry">Entry</option>
          <option value="exit">Exit</option>
          <option value="both">Entry and exit</option>
        </select>
      </label>
    </>
  );

  const now = panel?.server_time ?? Math.floor(Date.now() / 1000);
  const tz = event.timezone;
  // A hub row has no gate to move, only Revoke (a reset hub that could not reach the server leaves its row active).
  const menu = (d: Device) =>
    !hub &&
    !d.revoked && (
      <Menu
        label={`Actions for ${d.kind === "hub" ? "the hub" : (d.label ?? d.id.slice(0, 8))}`}
        items={[
          ...(d.kind === "scanner"
            ? [{ label: "Move to another gate…", onSelect: () => setDialog({ kind: "move", d }) }]
            : []),
          { label: "Revoke…", danger: true, onSelect: () => setDialog({ kind: "revoke", d }) },
        ]}
      />
    );
  const name = (d: Device) =>
    d.kind === "hub" ? "Hub" : (d.label ?? <code>{d.id.slice(0, 8)}</code>);

  return (
    <div>
      <div className="row" style={{ justifyContent: "flex-end", marginBottom: 14 }}>
        {!hub && (
          <>
            <button
              type="button"
              className="secondary"
              onClick={() => setDialog({ kind: "hubcodes" })}
            >
              Batch codes for the hub…
            </button>
            <button type="button" onClick={() => setDialog({ kind: "setup" })}>
              + Set up a phone
            </button>
          </>
        )}
      </div>
      {hub && (
        <Notice tone="warn">
          On the hub the panel is read-only. Moving, revoking and setting up phones is done on the
          VM.
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {panel?.devices.length === 0 && (
        <div className="card empty">
          <strong>No phones yet</strong>
          Use &quot;Set up a phone&quot; to get a one-time setup code.
        </div>
      )}
      {panel && panel.devices.length > 0 && phone && (
        <div className="grid">
          {panel.devices.map((d) => {
            const c = connection(d, now);
            return (
              <div
                className="card ticket-card"
                key={d.id}
                data-testid={`device-${d.label ?? d.id}`}
                data-state={c.label}
              >
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{name(d)}</div>
                  <div className="muted small">
                    {d.kind === "hub" ? "Venue hub" : `${d.gate} · ${directionLabel[d.direction]}`}
                  </div>
                  <div className="muted small">
                    {d.battery_pct === null ? "" : `${d.battery_pct}% · `}
                    {d.outbox_size ?? 0} waiting to upload
                  </div>
                  <span className={`tag ${c.tone}`} title={c.tip} style={{ marginTop: 6 }}>
                    {c.detail}
                  </span>
                </div>
                {menu(d)}
              </div>
            );
          })}
        </div>
      )}
      {panel && panel.devices.length > 0 && !phone && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table data-testid="device-table">
              <thead>
                <tr>
                  <th>Phone</th>
                  <th>Gate</th>
                  <th>Status</th>
                  <th>Last scan</th>
                  <th>Battery</th>
                  <th>Waiting to upload</th>
                  <th>
                    <span style={{ position: "absolute", left: -9999 }}>Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {panel.devices.map((d) => {
                  const c = connection(d, now);
                  return (
                    <tr
                      key={d.id}
                      className={c.hot ? "hot" : ""}
                      data-testid={`device-${d.label ?? d.id}`}
                      data-state={c.label}
                    >
                      <td>{name(d)}</td>
                      <td>
                        {d.kind === "hub" ? "—" : `${d.gate} · ${directionLabel[d.direction]}`}
                      </td>
                      <td>
                        <span className={`tag ${c.tone}`} title={c.tip}>
                          {c.detail}
                        </span>
                      </td>
                      <td>{d.last_scan_at ? hhmm(d.last_scan_at, tz) : "—"}</td>
                      <td>{d.battery_pct === null ? "—" : `${d.battery_pct}%`}</td>
                      <td>{d.outbox_size ?? "—"}</td>
                      <td>{menu(d)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="muted small">
        Highlighted rows have had no contact for over 10 minutes. Battery shows only for phones
        whose browser reports it.
      </p>

      {dialog?.kind === "setup" && (
        <FormDialog
          title="Set up a phone"
          submitLabel="Show setup QR"
          onClose={() => setDialog(undefined)}
          onSubmit={(f) => makeCodes(f, false)}
        >
          <p className="muted" style={{ margin: 0 }}>
            A one-time setup QR, valid for 10 minutes. Scan it from the phone&apos;s scanner page.
          </p>
          {gateAndRole()}
          <label className="field">
            Label (optional)
            <input name="label" aria-label="Label" placeholder="Phone 1" />
          </label>
        </FormDialog>
      )}
      {dialog?.kind === "hubcodes" && (
        <FormDialog
          title="Batch codes for the venue hub"
          submitLabel="Make hub setup codes"
          onClose={() => setDialog(undefined)}
          onSubmit={(f) => makeCodes(f, true)}
        >
          <p className="muted" style={{ margin: 0 }}>
            Single-use setup QRs that stay valid until the event ends, so phones can be set up at
            the venue with no internet.
          </p>
          {gateAndRole()}
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
        </FormDialog>
      )}
      {dialog?.kind === "move" && (
        <FormDialog
          title={`Move ${dialog.d.label ?? dialog.d.id.slice(0, 8)}`}
          submitLabel="Save"
          onClose={() => setDialog(undefined)}
          onSubmit={async (f) => {
            await api(`/api/devices/${dialog.d.id}`, {
              method: "PATCH",
              body: { gate: String(f.get("gate")), direction: String(f.get("direction")) },
            });
            setMsg({ tone: "ok", text: "Moved. The phone picks it up at its next sync." });
            await load();
          }}
        >
          {gateAndRole(dialog.d)}
        </FormDialog>
      )}
      {dialog?.kind === "revoke" && (
        <RevokeDialog
          device={dialog.d}
          me={me}
          onClose={() => setDialog(undefined)}
          onDone={(tone, text) => {
            setMsg({ tone, text });
            void load();
          }}
        />
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
