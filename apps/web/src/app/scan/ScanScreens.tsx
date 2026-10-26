"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Camera } from "./Camera";
import { CameraHelp } from "./CameraHelp";
import { unlockAudio } from "../../scanner/feedback";
import type { IdbStore } from "../../scanner/idbStore";
import {
  manualExit,
  overrideAdmit,
  type PipelineDeps,
  type ScanOutcome,
} from "../../scanner/pipeline";
import type { Icon, ResultView } from "../../scanner/result";
import type { Link } from "../../scanner/routes";
import { isSupervisor, loginStaffAny } from "../../scanner/staff";
import type { DeviceRecord, Direction, SyncTicket } from "../../scanner/types";

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** The event's name, when the key bundle carries it (older bundles do not). */
export const eventNameOf = (device: DeviceRecord): string | null =>
  (device.bundle as { event_name?: string }).event_name ?? null;

export const directionLabel = (device: DeviceRecord): string =>
  device.direction === "both" ? "Entry and exit" : device.direction === "exit" ? "Exit" : "Entry";

const LINK: Record<Link, string> = { hub: "Hub", cloud: "VM only", offline: "Offline" };

export function Pill({ link }: { link: Link }) {
  return (
    <span className="sc-pill" data-testid="pill" data-link={link}>
      <span className="dot" />
      {LINK[link]}
    </span>
  );
}

export function Header({
  device,
  staffName,
  link,
  onMenu,
}: {
  device: DeviceRecord;
  staffName?: string;
  link: Link;
  onMenu?: () => void;
}) {
  const event = eventNameOf(device);
  return (
    <header className="sc-head">
      <div className="who">
        {event && <div className="sc-event">{event}</div>}
        <h1 className="sc-gate" data-testid="ready">
          {device.gate}
          <span className="sc-sr">
            {" "}
            ·{" "}
            {device.direction === "both"
              ? "Entry / Exit"
              : device.direction === "exit"
                ? "Exit"
                : "Entry"}
          </span>
        </h1>
        <div className="sc-sub">
          {[staffName, device.label].filter(Boolean).join(" · ") || directionLabel(device)}
        </div>
      </div>
      <div className="right">
        <Pill link={link} />
        {onMenu && (
          <button type="button" className="sc-icon-btn" aria-label="Menu" onClick={onMenu}>
            ⋯
          </button>
        )}
      </div>
    </header>
  );
}

export function DirectionToggle({
  device,
  direction,
  onChange,
}: {
  device: DeviceRecord;
  direction: Direction;
  onChange: (d: Direction) => void;
}) {
  return (
    <div role="group" aria-label="Direction" className="sc-seg">
      {(["entry", "exit"] as const).map((d) => (
        <button
          key={d}
          type="button"
          data-dir={d}
          onClick={() => onChange(d)}
          aria-pressed={direction === d}
          disabled={device.direction !== "both" && device.direction !== d}
        >
          {d === "entry" ? "Entry" : "Exit"}
        </button>
      ))}
    </div>
  );
}

/** The ⋯ menu as a bottom sheet: staff, camera help, sign out, and "set up again" with its red confirm. */
export function MenuSheet({
  device,
  waiting,
  installEvent,
  onClose,
  onSwitchStaff,
  onSignOut,
  onRetryCamera,
  onEraseConfirmed,
}: {
  device: DeviceRecord;
  waiting: number;
  installEvent: BeforeInstallPromptEvent | null;
  onClose: () => void;
  onSwitchStaff: () => void;
  onSignOut: () => void;
  onRetryCamera: () => void;
  onEraseConfirmed: () => void;
}) {
  const [view, setView] = useState<"menu" | "help">("menu");
  const [erase, setErase] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="sc-sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="sc-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        data-testid="menu"
      >
        <div className="sc-grab" />
        <div className="sc-sheet-title">
          {[device.label, device.gate, directionLabel(device)].filter(Boolean).join(" · ")}
        </div>
        {view === "help" ? (
          <CameraHelp
            onBack={() => setView("menu")}
            onRetry={() => {
              onRetryCamera();
              onClose();
            }}
          />
        ) : (
          <>
            <button type="button" className="sc-sheet-item" onClick={onSwitchStaff}>
              Switch staff member
            </button>
            <button type="button" className="sc-sheet-item" onClick={() => setView("help")}>
              Camera help
            </button>
            {installEvent && (
              <button
                type="button"
                className="sc-sheet-item"
                onClick={() => void installEvent.prompt()}
              >
                Install app
              </button>
            )}
            <button type="button" className="sc-sheet-item" onClick={onSignOut}>
              Sign out
            </button>
            <div className="sc-rule" />
            {!erase ? (
              <button
                type="button"
                className="sc-sheet-item"
                style={{ color: "#fca5a5" }}
                onClick={() => setErase(true)}
              >
                Set up this phone again
              </button>
            ) : (
              <EraseBox
                waiting={waiting}
                onKeep={() => setErase(false)}
                onErase={onEraseConfirmed}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The red "Set this phone up again?" box: what gets erased, then Keep phone / Erase and set up. */
export function EraseBox({
  waiting,
  onKeep,
  onErase,
}: {
  waiting: number;
  onKeep: () => void;
  onErase: () => void;
}) {
  return (
    <div
      className="sc-erase"
      role="alertdialog"
      aria-label="Set this phone up again?"
      data-testid="erase-box"
    >
      <div className="t">Set this phone up again?</div>
      <div className="b">
        This erases the event, tickets and logins from this phone. You will need a new setup code
        from a supervisor.{" "}
        {waiting > 0
          ? `${waiting} scan${waiting === 1 ? " is" : "s are"} still waiting to upload; the phone tries to send them first, and a supervisor PIN is needed if that fails.`
          : "All scans are already uploaded."}
      </div>
      <div className="sc-pair">
        <button type="button" className="sc-btn" onClick={onKeep}>
          Keep phone
        </button>
        <button type="button" className="sc-btn danger" onClick={onErase}>
          Erase and set up
        </button>
      </div>
    </div>
  );
}

/** Scans that cannot be uploaded would be lost with the wipe: a supervisor must confirm. */
export function WipeConfirm({
  lost,
  onConfirm,
  onCancel,
}: {
  lost: number;
  onConfirm: (name: string, pin: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [error, setError] = useState("");
  return (
    <div
      className="sc-result"
      data-tone="red"
      role="alertdialog"
      data-testid="wipe-confirm"
      style={{ zIndex: 60 }}
    >
      <div className="mid">
        <div className="headline" style={{ fontSize: 30 }}>
          {lost} scan{lost === 1 ? "" : "s"} not uploaded
        </div>
        <p className="instruction" style={{ margin: 0 }}>
          They could not reach the hub or the server and will be lost if this phone is set up again.
          A supervisor can confirm.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            setError("");
            try {
              await onConfirm(String(form.get("name")), String(form.get("pin")));
            } catch (err) {
              setError(err instanceof Error ? err.message : "Could not confirm");
            }
          }}
        >
          <input className="sc-input" name="name" placeholder="Supervisor name" required />
          <input
            className="sc-input"
            name="pin"
            type="password"
            placeholder="Supervisor PIN"
            required
          />
          <button className="sc-btn danger" type="submit">
            Discard scans and set up again
          </button>
          <button className="sc-btn" type="button" onClick={onCancel}>
            Cancel
          </button>
          {error && (
            <p role="alert" className="sc-error" style={{ color: "#fff" }}>
              {error}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}

export function Setup({
  notice,
  canCancel,
  onCancel,
  onCode,
  installEvent,
}: {
  notice: string;
  canCancel: boolean;
  onCancel: () => void;
  onCode: (raw: string) => void;
  installEvent: BeforeInstallPromptEvent | null;
}) {
  const [scanning, setScanning] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <section className="sc-login">
      <h1 style={{ fontSize: 26 }}>Scanner</h1>
      <p style={{ margin: 0, color: "#aab3c2" }}>
        Scan the setup QR from the event&apos;s Devices page to use this phone as a scanner.
      </p>
      {!scanning ? (
        <button
          type="button"
          className="sc-btn primary"
          style={{ minHeight: 60, fontSize: 18 }}
          onClick={() => {
            unlockAudio();
            setScanning(true);
          }}
        >
          Set up for event
        </button>
      ) : (
        <Camera onCode={onCode} paused={false} hint="Point at the setup QR" />
      )}
      <details>
        <summary style={{ minHeight: 44, display: "flex", alignItems: "center" }}>
          Type the code instead
        </summary>
        <form
          className="sc-form"
          onSubmit={(e) => {
            e.preventDefault();
            onCode(typed.trim());
          }}
        >
          <input
            className="sc-input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="DEV1:…"
            aria-label="Setup code"
          />
          <button className="sc-btn" type="submit">
            Use code
          </button>
        </form>
      </details>
      {notice && (
        <p role="status" className="sc-notice">
          {notice}
        </p>
      )}
      <div className="grow" />
      {(canCancel || installEvent) && (
        <div className="sc-pair">
          {canCancel && (
            <button type="button" className="sc-btn" onClick={onCancel}>
              Back
            </button>
          )}
          {installEvent && (
            <button type="button" className="sc-btn" onClick={() => void installEvent.prompt()}>
              Install app
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function Login({
  device,
  onLogin,
  onSetupAgain,
  link,
  waiting,
  notice,
}: {
  device: DeviceRecord;
  onLogin: (name: string, pin: string) => Promise<void>;
  onSetupAgain: () => void;
  link: Link;
  waiting: number;
  notice: string;
}) {
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [erase, setErase] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setWorking(true);
    setError("");
    try {
      await onLogin(String(form.get("name")), String(form.get("pin")));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setWorking(false);
    }
  }
  return (
    <section className="sc-login">
      <Header device={device} link={link} />
      <form onSubmit={submit} className="sc-form">
        <div style={{ fontWeight: 600 }}>Staff login</div>
        <input
          className="sc-input"
          name="name"
          placeholder="Name"
          autoComplete="username"
          autoCapitalize="none"
          required
        />
        <input
          className="sc-input"
          name="pin"
          type="password"
          placeholder="PIN"
          autoComplete="current-password"
          required
        />
        <button
          className="sc-btn primary"
          type="submit"
          disabled={working}
          style={{ minHeight: 56 }}
        >
          Log in
        </button>
      </form>
      {error && (
        <p role="alert" className="sc-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="sc-notice">
          {notice}
        </p>
      )}
      <div className="grow" />
      <div className="sc-counts">
        <span />
        <span data-testid="waiting">{waiting} waiting to upload</span>
      </div>
      {!erase ? (
        <button type="button" className="sc-link" onClick={() => setErase(true)}>
          Set up this phone again
        </button>
      ) : (
        <EraseBox waiting={waiting} onKeep={() => setErase(false)} onErase={onSetupAgain} />
      )}
    </section>
  );
}

function ResultIcon({ icon }: { icon: Icon }) {
  switch (icon) {
    case "check":
      return (
        <svg aria-hidden="true" viewBox="0 0 132 132" fill="none">
          <circle cx="66" cy="66" r="62" stroke="#fff" strokeWidth="8" />
          <path
            d="M38 68 L58 88 L96 46"
            stroke="#fff"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "exit":
      return (
        <svg aria-hidden="true" viewBox="0 0 132 132" fill="none">
          <circle cx="66" cy="66" r="62" stroke="#fff" strokeWidth="8" />
          <path
            d="M34 66 H90 M70 44 L92 66 L70 88"
            stroke="#fff"
            strokeWidth="12"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "warn":
      return (
        <svg aria-hidden="true" viewBox="0 0 132 132" fill="none">
          <circle cx="66" cy="66" r="62" stroke="#fff" strokeWidth="8" />
          <path d="M66 36 V74" stroke="#fff" strokeWidth="12" strokeLinecap="round" />
          <circle cx="66" cy="94" r="7" fill="#fff" />
        </svg>
      );
    default:
      return (
        <svg aria-hidden="true" viewBox="0 0 132 132" fill="none">
          <circle cx="66" cy="66" r="62" stroke="#fff" strokeWidth="8" />
          <path
            d="M44 44 L88 88 M88 44 L44 88"
            stroke="#fff"
            strokeWidth="12"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}

/** Full-screen colour result. Green and exit screens count down and skip on tap; the rest wait for "Next scan". */
export function ResultScreen({
  view,
  context,
  onDismiss,
  onOverride,
}: {
  view: ResultView;
  context: string;
  onDismiss: () => void;
  onOverride: (name: string, pin: string) => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const auto = view.dismissMs !== null;
  return (
    <div
      className="sc-result"
      role="alertdialog"
      aria-live="assertive"
      data-testid="result"
      data-tone={view.tone}
      onClick={() => {
        if (!asking) onDismiss();
      }}
    >
      {view.banner && (
        <div className="banner" data-testid="result-banner">
          {view.banner}
        </div>
      )}
      <div className="ctx">{context}</div>
      <div className="mid">
        <ResultIcon icon={view.icon} />
        <div className="headline" data-testid="result-title">
          {view.headline}
        </div>
        {(view.holder || view.typeName) && (
          <div>
            {view.holder && (
              <div
                className={`holder${view.tone === "red" ? " small" : ""}`}
                data-testid="result-holder"
              >
                {view.holder}
                {view.tone === "red" && view.typeName ? ` · ${view.typeName}` : ""}
              </div>
            )}
            {(view.tone !== "red" || !view.holder) && (view.typeName || view.chips.length > 0) && (
              <div className="chips" style={{ marginTop: 6 }}>
                {view.typeName && <span className="chip type">{view.typeName}</span>}
                {view.chips.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
        {view.details.length > 0 && (
          <div className="facts" data-testid="result-details">
            {view.details.map((d) => (
              <div key={d}>{d}</div>
            ))}
          </div>
        )}
        {view.instruction && <div className="instruction">{view.instruction}</div>}
        {view.override && !asking && (
          <button
            type="button"
            className="sc-btn"
            onClick={(e) => {
              e.stopPropagation();
              setAsking(true);
            }}
          >
            Supervisor override
          </button>
        )}
        {asking && (
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setError("");
              try {
                await onOverride(String(form.get("name")), String(form.get("pin")));
              } catch (err) {
                setError(err instanceof Error ? err.message : "Override failed");
              }
            }}
          >
            <input className="sc-input" name="name" placeholder="Supervisor name" required />
            <input
              className="sc-input"
              name="pin"
              type="password"
              placeholder="Supervisor PIN"
              required
            />
            <div className="sc-pair">
              <button className="sc-btn" type="button" onClick={onDismiss}>
                Cancel
              </button>
              <button className="sc-btn primary" type="submit">
                Admit
              </button>
            </div>
            {error && (
              <p role="alert" style={{ margin: 0 }}>
                {error}
              </p>
            )}
          </form>
        )}
      </div>
      {auto ? (
        <>
          <div className="sc-countdown" aria-hidden="true">
            <div data-testid="countdown" style={{ animationDuration: `${view.dismissMs}ms` }} />
          </div>
          <div className="sc-skip">Next scan in a moment · tap to skip</div>
        </>
      ) : (
        !asking && (
          <button
            type="button"
            className="next"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
            Next scan
          </button>
        )
      )}
    </div>
  );
}

export function Search({
  store,
  device,
  direction,
  onClose,
  deps,
  guard,
}: {
  store: IdbStore;
  device: DeviceRecord;
  direction: Direction;
  onClose: () => void;
  deps: () => PipelineDeps | undefined;
  guard: (work: () => Promise<ScanOutcome>) => Promise<void>;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SyncTicket[]>([]);
  const [chosen, setChosen] = useState<SyncTicket | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const typeName = (t: SyncTicket) =>
    device.ticketTypes.find((x) => x.idx === t.ticket_type)?.name ?? `Type ${t.ticket_type}`;

  useEffect(() => {
    let live = true;
    store
      .searchTickets(q)
      .then((r) => live && setHits(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [q, store]);

  return (
    <div className="sc" style={{ zIndex: 20 }} data-testid="search">
      <div className="sc-head">
        <h1 style={{ fontSize: 22 }}>Find a ticket by name</h1>
        <button type="button" className="sc-btn" onClick={onClose}>
          Close
        </button>
      </div>
      <input
        className="sc-input"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setChosen(null);
        }}
        placeholder="Name or last 6 characters of the ticket"
        aria-label="Search"
        autoFocus
      />
      <div className="scroll" style={{ flex: 1 }}>
        {!chosen && (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {hits.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="sc-btn"
                  style={{ width: "100%", textAlign: "left" }}
                  onClick={() => setChosen(t)}
                >
                  {t.holder_name ?? "(no name)"} · {typeName(t)} · …{t.id.slice(-6)}
                </button>
              </li>
            ))}
            {q.trim().length >= 2 && hits.length === 0 && (
              <li style={{ color: "#aab3c2" }}>No matching ticket in this phone&apos;s list.</li>
            )}
          </ul>
        )}
        {chosen && (
          <section className="sc-form">
            <h2 style={{ margin: 0 }}>{chosen.holder_name ?? "(no name)"}</h2>
            <p style={{ margin: 0, color: "#d5dae3" }}>
              {typeName(chosen)} · …{chosen.id.slice(-6)}
              <br />
              Status: {chosen.status}
              {chosen.inside ? " · inside" : ""} · entries used {chosen.admits_used}
            </p>
            {direction === "exit" ? (
              <button
                type="button"
                className="sc-btn primary"
                onClick={() => {
                  const d = deps();
                  if (!d) return;
                  onClose();
                  void guard(() => manualExit(d, chosen));
                }}
              >
                Record exit
              </button>
            ) : !asking ? (
              <button type="button" className="sc-btn primary" onClick={() => setAsking(true)}>
                Admit (supervisor PIN)
              </button>
            ) : (
              <form
                className="sc-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = new FormData(e.currentTarget);
                  setError("");
                  try {
                    const sup = await loginStaffAny(
                      store,
                      device,
                      String(form.get("name")),
                      String(form.get("pin")),
                    );
                    if (!isSupervisor(sup)) throw new Error("That account is not a supervisor");
                    const d = deps();
                    if (!d) return;
                    onClose();
                    await guard(() => overrideAdmit(d, chosen.id, typeName(chosen), sup, chosen));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed");
                  }
                }}
              >
                <input className="sc-input" name="name" placeholder="Supervisor name" required />
                <input
                  className="sc-input"
                  name="pin"
                  type="password"
                  placeholder="Supervisor PIN"
                  required
                />
                <button type="submit" className="sc-btn primary">
                  Admit
                </button>
                {error && (
                  <p role="alert" className="sc-error">
                    {error}
                  </p>
                )}
              </form>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
