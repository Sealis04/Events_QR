"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { Camera } from "./Camera";
import { warmZxing } from "../../scanner/decoder";
import { AuthError, NetworkError } from "../../scanner/client";
import { syncCycle } from "../../scanner/cycle";
import { drainOutbox } from "../../scanner/outbox";
import { feedback, unlockAudio } from "../../scanner/feedback";
import { IdbStore } from "../../scanner/idbStore";
import {
  manualExit,
  overrideAdmit,
  processScan,
  type PipelineDeps,
  type ScanOutcome,
} from "../../scanner/pipeline";
import { resultView, type ResultView, type Tone } from "../../scanner/result";
import { clientsFor, RoutedClient, type Link } from "../../scanner/routes";
import { setUpAgain } from "../../scanner/reset";
import { EnrollFailed, enrollFromSetupQr } from "../../scanner/sync";
import { isSupervisor, loginStaffAny } from "../../scanner/staff";
import type { DeviceRecord, Direction, StaffSession, SyncTicket } from "../../scanner/types";

declare global {
  interface Window {
    /** Test hook: feeds a code as if the camera had read it. Same path as a real scan. */
    __scannerFeed?: (raw: string) => Promise<void>;
  }
  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
  }
}

const DEBOUNCE_MS = 3000;
const SYNC_EVERY_MS = 10_000;
/** An offline phone beeps this often so a supervisor notices and fixes the link. */
const OFFLINE_BEEP_MS = 60_000;
/** With the hub and the VM both down, the VM gets less time per scan so the gate keeps moving. */
const CLOUD_TIMEOUT_OFFLINE_MS = 1200;
const STAFF_KEY = "scanner.staff";

const COLORS: Record<Tone, { bg: string; fg: string }> = {
  green: { bg: "#15803d", fg: "#fff" },
  blue: { bg: "#1d4ed8", fg: "#fff" },
  grey: { bg: "#6b7280", fg: "#fff" },
  red: { bg: "#b91c1c", fg: "#fff" },
  amber: { bg: "#f59e0b", fg: "#111" },
  orange: { bg: "#ea580c", fg: "#fff" },
};

const page: CSSProperties = {
  position: "fixed",
  inset: 0,
  overflowY: "auto",
  background: "#111827",
  color: "#f9fafb",
  fontFamily: "system-ui, sans-serif",
  padding: "12px 16px",
  zIndex: 10,
};
const button: CSSProperties = {
  padding: "12px 16px",
  fontSize: 16,
  borderRadius: 10,
  border: "none",
  background: "#374151",
  color: "#fff",
};
const input: CSSProperties = {
  padding: 12,
  fontSize: 16,
  borderRadius: 8,
  border: "1px solid #4b5563",
  background: "#1f2937",
  color: "#fff",
};

/**
 * Files fetched before the service worker took control (the first visit) are not in its cache, so
 * hand it everything this page has loaded. After this the scanner reloads with the network off.
 */
async function cacheLoadedAssets(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const urls = performance
    .getEntriesByType("resource")
    .map((e) => new URL(e.name, location.href))
    .filter((u) => u.origin === location.origin && u.pathname.startsWith("/_next/static/"))
    .map((u) => u.pathname + u.search);
  registration.active?.postMessage({ type: "cache-urls", urls: [...new Set(urls)] });
}

type Result = { view: ResultView; at: number };

/** Battery level 0-100 where the browser has the Battery API (Chromium), else null. */
async function readBattery(): Promise<number | null> {
  const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number }> };
  if (!nav.getBattery) return null;
  return Math.round((await nav.getBattery()).level * 100);
}

export function ScannerApp() {
  const store = useMemo(() => new IdbStore(), []);
  const [booted, setBooted] = useState(false);
  const [device, setDevice] = useState<DeviceRecord | undefined>();
  const [staff, setStaff] = useState<StaffSession | null>(null);
  const [direction, setDirection] = useState<Direction>("entry");
  const [settingUp, setSettingUp] = useState(false);
  /** Set when "Set up again" found scans that would be lost: how many, until a supervisor confirms. */
  const [confirmWipe, setConfirmWipe] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<Link>("cloud");
  const [outbox, setOutbox] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);

  const deviceRef = useRef(device);
  deviceRef.current = device;
  const linkRef = useRef(link);
  linkRef.current = link;
  const staffRef = useRef(staff);
  staffRef.current = staff;
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const resultRef = useRef(result);
  resultRef.current = result;
  const busy = useRef(false);
  const last = useRef<{ raw: string; at: number } | null>(null);
  const settingUpRef = useRef(settingUp);
  settingUpRef.current = settingUp;

  // Boot: service worker, install prompt, saved device and staff.
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/scan-sw.js", { scope: "/scan" }).catch(() => undefined);
    }
    const onInstall = (e: Event) => {
      e.preventDefault();
      setInstallEvent(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    (async () => {
      const saved = await store.getDevice().catch(() => undefined);
      setDevice(saved);
      if (saved) setDirection(saved.direction === "exit" ? "exit" : "entry");
      try {
        const raw = sessionStorage.getItem(STAFF_KEY);
        if (raw) setStaff(JSON.parse(raw) as StaffSession);
      } catch {
        // no saved login
      }
      setOutbox(await store.outboxCount().catch(() => 0));
      setBooted(true);
    })();
    return () => window.removeEventListener("beforeinstallprompt", onInstall);
  }, [store]);

  const ready = !!device && device.synced && !settingUp;

  // Load the QR decoder's WASM while the network is up, so the camera also works offline later.
  useEffect(() => {
    if (!ready) return;
    void warmZxing().then(cacheLoadedAssets);
  }, [ready]);

  const wipeDevice = useCallback(
    async (message: string) => {
      await store.wipe();
      sessionStorage.removeItem(STAFF_KEY);
      setDevice(undefined);
      setStaff(null);
      setSettingUp(false);
      setNotice(message);
    },
    [store],
  );

  // Background pass every 10 s, and when the browser says it is back online: upload the outbox,
  // pull ticket changes, wipe on revocation or once the event is over (see scanner/cycle.ts).
  useEffect(() => {
    if (!device?.synced && !device?.ended) return;
    let stopped = false;
    const run = async () => {
      const current = deviceRef.current;
      if (!current || stopped) return;
      try {
        const res = await syncCycle(store, current, { battery: readBattery });
        if (stopped) return;
        if (res.kind === "revoked") {
          await wipeDevice("This phone was removed from the event. Set it up again.");
          return;
        }
        if (res.kind === "ended") {
          setDevice(res.device);
          setStaff(null);
          sessionStorage.removeItem(STAFF_KEY);
          setNotice("The event is over. Keys and ticket lists were removed from this phone.");
        } else {
          setDevice(res.device);
          setLink(res.kind === "ok" ? res.link : "offline");
        }
      } catch {
        if (!stopped) setLink("offline");
      }
      setOutbox(await store.outboxCount().catch(() => 0));
    };
    void run();
    const timer = setInterval(run, SYNC_EVERY_MS);
    window.addEventListener("online", run);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", run);
    };
  }, [device?.synced, device?.ended, store, wipeDevice]);

  // Offline: beep every 60 s (and show the orange banner) so someone notices.
  useEffect(() => {
    if (link !== "offline" || !device?.synced) return;
    const t = setInterval(() => feedback({ sound: "bad" }), OFFLINE_BEEP_MS);
    return () => clearInterval(t);
  }, [link, device?.synced]);

  const show = useCallback((outcome: ScanOutcome) => {
    const view = resultView(outcome);
    feedback(view);
    setResult({ view, at: Date.now() });
  }, []);

  // Auto-dismiss: green 1.5 s, blue 1 s; the red and amber screens wait for a tap.
  useEffect(() => {
    if (!result || result.view.dismissMs === null) return;
    const t = setTimeout(() => setResult(null), result.view.dismissMs);
    return () => clearTimeout(t);
  }, [result]);

  const deps = useCallback((): PipelineDeps | undefined => {
    const d = deviceRef.current;
    if (!d) return undefined;
    return {
      store,
      // Hub first with an 800 ms limit, retried on every scan; the VM when the hub is silent.
      client: new RoutedClient(
        clientsFor(d, {
          cloudTimeoutMs: linkRef.current === "offline" ? CLOUD_TIMEOUT_OFFLINE_MS : undefined,
        }),
        setLink,
      ),
      device: d,
      staff: staffRef.current,
      now: () => Math.floor(Date.now() / 1000) + d.clockOffset,
      newId: () => crypto.randomUUID(),
    };
  }, [store]);

  const guard = useCallback(
    async (work: () => Promise<ScanOutcome>) => {
      busy.current = true;
      try {
        show(await work());
      } catch (err) {
        if (err instanceof AuthError)
          await wipeDevice("This phone was removed from the event. Set it up again.");
        else if (err instanceof NetworkError) show({ kind: "no_connection" });
        else setNotice(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        busy.current = false;
        let queued = await store.outboxCount().catch(() => 0);
        // A server just answered a scan: send what the phone decided alone straight away.
        const d = deviceRef.current;
        if (queued > 0 && d && linkRef.current !== "offline") {
          await drainOutbox(store, clientsFor(d)).catch(() => undefined);
          queued = await store.outboxCount().catch(() => queued);
        }
        setOutbox(queued);
      }
    },
    [show, store, wipeDevice],
  );

  /** "Set up again": upload what is queued, wipe the phone, show the setup screen. */
  async function beginSetUpAgain(supervisor?: { name: string; pin: string }) {
    const d = deviceRef.current;
    if (!d) return;
    setNotice("Uploading queued scans…");
    const res = await setUpAgain(store, d, { supervisor });
    if (res.kind === "needs_supervisor") {
      setNotice("");
      setConfirmWipe(res.lost);
      return;
    }
    setConfirmWipe(null);
    sessionStorage.removeItem(STAFF_KEY);
    setDevice(undefined);
    setStaff(null);
    setOutbox(0);
    setSettingUp(false);
    setNotice("");
  }

  const enrol = useCallback(
    async (raw: string) => {
      busy.current = true;
      setNotice("Setting up…");
      try {
        const next = await enrollFromSetupQr(store, raw, { pageOrigin: location.origin });
        void navigator.storage?.persist?.();
        setDevice(next);
        setDirection(next.direction === "exit" ? "exit" : "entry");
        setSettingUp(false);
        setNotice("");
        setLink(next.hubUrl ? "hub" : "cloud");
      } catch (err) {
        setNotice(err instanceof EnrollFailed ? err.message : "Setup failed. Try the code again.");
      } finally {
        busy.current = false;
      }
    },
    [store],
  );

  const handleCode = useCallback(
    async (raw: string) => {
      if (busy.current || resultRef.current) return;
      const now = Date.now();
      const prev = last.current;
      if (prev && prev.raw === raw && now - prev.at < DEBOUNCE_MS) return;
      last.current = { raw, at: now };

      const d = deviceRef.current;
      if (!d || !d.synced || settingUpRef.current) {
        if (raw.startsWith("DEV1:")) await enrol(raw);
        else setNotice("Scan a scanner setup code first.");
        return;
      }
      if (!staffRef.current) return;
      if (raw.startsWith("DEV1:")) {
        setNotice("That is a setup code. Tap “Set up again” to use it.");
        return;
      }
      const dd = deps();
      if (!dd) return;
      await guard(() => processScan(dd, raw, directionRef.current));
    },
    [deps, enrol, guard],
  );

  const handleRef = useRef(handleCode);
  handleRef.current = handleCode;
  useEffect(() => {
    window.__scannerFeed = (raw) => handleRef.current(raw);
    return () => {
      delete window.__scannerFeed;
    };
  }, []);

  async function login(name: string, pin: string) {
    const d = deviceRef.current!;
    const session = await loginStaffAny(store, d, name, pin);
    unlockAudio();
    sessionStorage.setItem(STAFF_KEY, JSON.stringify(session));
    setStaff(session);
  }

  function signOut() {
    sessionStorage.removeItem(STAFF_KEY);
    setStaff(null);
  }

  if (!booted) {
    return (
      <main style={page}>
        <p>Loading…</p>
      </main>
    );
  }

  const phase = !device || !device.synced || settingUp ? "setup" : !staff ? "login" : "scan";

  return (
    <main style={page} data-phase={phase}>
      {phase === "setup" && (
        <Setup
          notice={notice}
          canCancel={!!device && device.synced}
          onCancel={() => {
            setSettingUp(false);
            setNotice("");
          }}
          onCode={(raw) => void handleCode(raw)}
          installEvent={installEvent}
        />
      )}
      {phase === "login" && device && (
        <Login
          device={device}
          onLogin={login}
          onSetupAgain={() =>
            void beginSetUpAgain().catch(() => setNotice("Could not set up again."))
          }
          link={link}
          outbox={outbox}
        />
      )}
      {phase === "scan" && device && staff && (
        <>
          {link === "offline" && (
            <div
              role="status"
              data-testid="offline-banner"
              style={{
                background: COLORS.orange.bg,
                color: COLORS.orange.fg,
                padding: "8px 12px",
                borderRadius: 8,
                marginBottom: 8,
                fontWeight: 600,
              }}
            >
              OFFLINE · scans are saved on this phone and uploaded when the link is back
            </div>
          )}
          <Header device={device} staff={staff} link={link} outbox={outbox} />
          {device.direction === "both" && (
            <div
              role="group"
              aria-label="Direction"
              style={{ display: "flex", gap: 8, margin: "8px 0" }}
            >
              {(["entry", "exit"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  aria-pressed={direction === d}
                  style={{
                    ...button,
                    flex: 1,
                    background:
                      direction === d ? (d === "entry" ? "#15803d" : "#1d4ed8") : "#374151",
                  }}
                >
                  {d === "entry" ? "Entry" : "Exit"}
                </button>
              ))}
            </div>
          )}
          <Camera onCode={(raw) => void handleCode(raw)} paused={!!result || showSearch} />
          {notice && (
            <p role="status" style={{ color: "#fcd34d" }}>
              {notice}
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button style={button} onClick={() => setShowSearch(true)}>
              Manual search
            </button>
            <button
              style={button}
              onClick={() =>
                void beginSetUpAgain().catch(() => setNotice("Could not set up again."))
              }
            >
              Set up again
            </button>
            <button style={button} onClick={signOut}>
              Sign out
            </button>
            {installEvent && (
              <button style={button} onClick={() => void installEvent.prompt()}>
                Install app
              </button>
            )}
          </div>
        </>
      )}
      {confirmWipe !== null && (
        <WipeConfirm
          lost={confirmWipe}
          onConfirm={(name, pin) => beginSetUpAgain({ name, pin })}
          onCancel={() => setConfirmWipe(null)}
        />
      )}
      {showSearch && device && staff && (
        <Search
          store={store}
          device={device}
          direction={direction}
          onClose={() => setShowSearch(false)}
          deps={deps}
          guard={guard}
        />
      )}
      {result && (
        <ResultScreen
          view={result.view}
          onDismiss={() => setResult(null)}
          onOverride={async (name, pin) => {
            const sup = await loginStaffAny(store, deviceRef.current!, name, pin);
            if (!isSupervisor(sup)) throw new Error("That account is not a supervisor");
            const dd = deps();
            const ov = result.view.override;
            if (!dd || !ov) return;
            setResult(null);
            await guard(() => overrideAdmit(dd, ov.ticketId, ov.typeName, sup, undefined, ov.stub));
          }}
        />
      )}
    </main>
  );
}

function WipeConfirm({
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
      role="alertdialog"
      data-testid="wipe-confirm"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: "#7f1d1d",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        textAlign: "center",
        gap: 8,
      }}
    >
      <h1 style={{ fontSize: 28, margin: 0 }}>
        {lost} scan{lost === 1 ? "" : "s"} not uploaded
      </h1>
      <p style={{ fontSize: 18, margin: 0 }}>
        They could not reach the hub or the server and will be lost if this phone is set up again. A
        supervisor can confirm.
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
        style={{ display: "grid", gap: 8, marginTop: 16, width: "min(320px, 100%)" }}
      >
        <input style={input} name="name" placeholder="Supervisor name" required />
        <input style={input} name="pin" type="password" placeholder="Supervisor PIN" required />
        <button style={{ ...button, background: "#111827" }} type="submit">
          Discard scans and set up again
        </button>
        <button style={button} type="button" onClick={onCancel}>
          Cancel
        </button>
        {error && (
          <p role="alert" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </form>
    </div>
  );
}

function Header({
  device,
  staff,
  link,
  outbox,
}: {
  device: DeviceRecord;
  staff: StaffSession;
  link: Link;
  outbox: number;
}) {
  const role =
    device.direction === "both" ? "Entry / Exit" : device.direction === "exit" ? "Exit" : "Entry";
  return (
    <header
      style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
    >
      <div>
        <h1 data-testid="ready" style={{ margin: 0, fontSize: 22 }}>
          {device.gate} · {role}
        </h1>
        <small style={{ color: "#9ca3af" }}>
          {staff.name}
          {device.label ? ` · ${device.label}` : ""}
        </small>
      </div>
      <Pill link={link} outbox={outbox} />
    </header>
  );
}

const PILL: Record<Link, { label: string; bg: string }> = {
  hub: { label: "Hub", bg: "#15803d" },
  cloud: { label: "Cloud-only", bg: "#1d4ed8" },
  offline: { label: "Offline", bg: "#ea580c" },
};

function Pill({ link, outbox }: { link: Link; outbox: number }) {
  return (
    <span
      data-testid="pill"
      data-link={link}
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 13,
        background: PILL[link].bg,
        color: "#fff",
        whiteSpace: "nowrap",
      }}
    >
      {PILL[link].label} · {outbox} queued
    </span>
  );
}

function Setup({
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
    <section>
      <h1 style={{ fontSize: 24 }}>Scanner</h1>
      <p>Scan the setup QR from the event&apos;s Devices page to use this phone as a scanner.</p>
      {!scanning ? (
        <button
          style={{ ...button, background: "#2563eb", width: "100%" }}
          onClick={() => {
            unlockAudio();
            setScanning(true);
          }}
        >
          Set up for event
        </button>
      ) : (
        <Camera onCode={onCode} paused={false} />
      )}
      <details style={{ marginTop: 16 }}>
        <summary>Type the code instead</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onCode(typed.trim());
          }}
          style={{ display: "grid", gap: 8, marginTop: 8 }}
        >
          <input
            style={input}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="DEV1:…"
            aria-label="Setup code"
          />
          <button style={button} type="submit">
            Use code
          </button>
        </form>
      </details>
      {notice && (
        <p role="status" style={{ color: "#fcd34d" }}>
          {notice}
        </p>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {canCancel && (
          <button style={button} onClick={onCancel}>
            Back
          </button>
        )}
        {installEvent && (
          <button style={button} onClick={() => void installEvent.prompt()}>
            Install app
          </button>
        )}
      </div>
    </section>
  );
}

function Login({
  device,
  onLogin,
  onSetupAgain,
  link,
  outbox,
}: {
  device: DeviceRecord;
  onLogin: (name: string, pin: string) => Promise<void>;
  onSetupAgain: () => void;
  link: Link;
  outbox: number;
}) {
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
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
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 data-testid="ready" style={{ fontSize: 22, margin: 0 }}>
          {device.gate} ·{" "}
          {device.direction === "both"
            ? "Entry / Exit"
            : device.direction === "exit"
              ? "Exit"
              : "Entry"}
        </h1>
        <Pill link={link} outbox={outbox} />
      </div>
      <p>Staff login</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        <input style={input} name="name" placeholder="Name" autoComplete="username" required />
        <input
          style={input}
          name="pin"
          type="password"
          placeholder="PIN"
          autoComplete="current-password"
          required
        />
        <button style={{ ...button, background: "#2563eb" }} type="submit" disabled={working}>
          Log in
        </button>
      </form>
      {error && (
        <p role="alert" style={{ color: "#fca5a5" }}>
          {error}
        </p>
      )}
      <button style={{ ...button, marginTop: 16 }} onClick={onSetupAgain}>
        Set up again
      </button>
    </section>
  );
}

function ResultScreen({
  view,
  onDismiss,
  onOverride,
}: {
  view: ResultView;
  onDismiss: () => void;
  onOverride: (name: string, pin: string) => Promise<void>;
}) {
  const { bg, fg } = COLORS[view.tone];
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      data-testid="result"
      data-tone={view.tone}
      onClick={() => {
        if (!asking && view.dismissMs === null) onDismiss();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        background: bg,
        color: fg,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        textAlign: "center",
        gap: 8,
      }}
    >
      {view.banner && (
        <div
          data-testid="result-banner"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            padding: "10px 12px",
            background: COLORS.orange.bg,
            color: COLORS.orange.fg,
            fontWeight: 700,
            letterSpacing: 2,
          }}
        >
          {view.banner}
        </div>
      )}
      <h1 data-testid="result-title" style={{ fontSize: 34, margin: 0 }}>
        {view.title}
      </h1>
      {view.lines.map((line) => (
        <p key={line} style={{ fontSize: 20, margin: 0 }}>
          {line}
        </p>
      ))}
      {view.override && !asking && (
        <button
          style={{ ...button, marginTop: 24, background: "#111827" }}
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
          style={{ display: "grid", gap: 8, marginTop: 16, width: "min(320px, 100%)" }}
        >
          <input style={input} name="name" placeholder="Supervisor name" required />
          <input style={input} name="pin" type="password" placeholder="Supervisor PIN" required />
          <button style={{ ...button, background: "#111827" }} type="submit">
            Admit
          </button>
          <button style={button} type="button" onClick={onDismiss}>
            Cancel
          </button>
          {error && (
            <p role="alert" style={{ margin: 0 }}>
              {error}
            </p>
          )}
        </form>
      )}
      {view.dismissMs === null && !asking && (
        <small style={{ marginTop: 24, opacity: 0.8 }}>Tap to dismiss</small>
      )}
    </div>
  );
}

function Search({
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
    <div style={{ ...page, zIndex: 20 }} data-testid="search">
      <button style={button} onClick={onClose}>
        Close
      </button>
      <h2>Manual search</h2>
      <input
        style={{ ...input, width: "100%", boxSizing: "border-box" }}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setChosen(null);
        }}
        placeholder="Name or last 6 characters of the ticket"
        aria-label="Search"
        autoFocus
      />
      {!chosen && (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {hits.map((t) => (
            <li key={t.id}>
              <button
                style={{ ...button, width: "100%", textAlign: "left", marginTop: 8 }}
                onClick={() => setChosen(t)}
              >
                {t.holder_name ?? "(no name)"} · {typeName(t)} · …{t.id.slice(-6)}
              </button>
            </li>
          ))}
          {q.trim().length >= 2 && hits.length === 0 && (
            <li>No matching ticket in this phone&apos;s list.</li>
          )}
        </ul>
      )}
      {chosen && (
        <section>
          <h3>{chosen.holder_name ?? "(no name)"}</h3>
          <p>
            {typeName(chosen)} · …{chosen.id.slice(-6)}
            <br />
            Status: {chosen.status}
            {chosen.inside ? " · inside" : ""} · entries used {chosen.admits_used}
          </p>
          {direction === "exit" ? (
            <button
              style={{ ...button, background: "#1d4ed8" }}
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
            <button style={{ ...button, background: "#15803d" }} onClick={() => setAsking(true)}>
              Admit (supervisor PIN)
            </button>
          ) : (
            <form
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
              style={{ display: "grid", gap: 8, maxWidth: 320 }}
            >
              <input style={input} name="name" placeholder="Supervisor name" required />
              <input
                style={input}
                name="pin"
                type="password"
                placeholder="Supervisor PIN"
                required
              />
              <button style={{ ...button, background: "#15803d" }} type="submit">
                Admit
              </button>
              {error && <p role="alert">{error}</p>}
            </form>
          )}
        </section>
      )}
    </div>
  );
}
