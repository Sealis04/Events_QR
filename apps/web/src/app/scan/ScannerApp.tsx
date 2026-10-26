"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera } from "./Camera";
import {
  DirectionToggle,
  Header,
  Login,
  MenuSheet,
  ResultScreen,
  Search,
  Setup,
  WipeConfirm,
  directionLabel,
  type BeforeInstallPromptEvent,
} from "./ScanScreens";
import { warmZxing } from "../../scanner/decoder";
import { AuthError, NetworkError } from "../../scanner/client";
import { bumpCount, readCounts, type TodayCounts } from "../../scanner/counts";
import { syncCycle } from "../../scanner/cycle";
import { drainOutbox } from "../../scanner/outbox";
import { feedback, unlockAudio } from "../../scanner/feedback";
import { IdbStore } from "../../scanner/idbStore";
import {
  overrideAdmit,
  processScan,
  type PipelineDeps,
  type ScanOutcome,
} from "../../scanner/pipeline";
import { resultView, type ResultView } from "../../scanner/result";
import { clientsFor, RoutedClient, type Link } from "../../scanner/routes";
import { setUpAgain } from "../../scanner/reset";
import {
  clearSession,
  loadSession,
  saveSession,
  serverNow,
  sessionExpiresAt,
} from "../../scanner/session";
import { EnrollFailed, enrollFromSetupQr } from "../../scanner/sync";
import { isSupervisor, loginStaffAny } from "../../scanner/staff";
import type { DeviceRecord, Direction, StaffSession } from "../../scanner/types";

declare global {
  interface Window {
    /** Test hook: feeds a code as if the camera had read it. Same path as a real scan. */
    __scannerFeed?: (raw: string) => Promise<void>;
  }
}

const DEBOUNCE_MS = 3000;
const SYNC_EVERY_MS = 10_000;
/** The saved login is re-checked this often, so the cut-off also applies to a phone left open. */
const SESSION_CHECK_MS = 30_000;
/** An offline phone beeps this often so a supervisor notices and fixes the link. */
const OFFLINE_BEEP_MS = 60_000;
/** With the hub and the VM both down, the VM gets less time per scan so the gate keeps moving. */
const CLOUD_TIMEOUT_OFFLINE_MS = 1200;

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
  const [today, setToday] = useState<TodayCounts>({ day: 0, in: 0, out: 0 });
  const [result, setResult] = useState<Result | null>(null);
  const [showSearch, setShowSearch] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  /** Bumped by "Try camera again": remounts the camera so it asks for the stream anew. */
  const [cameraKey, setCameraKey] = useState(0);
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

  // Boot: service worker, install prompt, saved device and the saved staff login.
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
      if (saved) {
        setDirection(saved.direction === "exit" ? "exit" : "entry");
        setStaff(await loadSession(store, saved).catch(() => null));
        setToday(
          await readCounts(store, saved, serverNow(saved)).catch(() => ({ day: 0, in: 0, out: 0 })),
        );
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
      await store.wipe(); // also deletes the saved login
      setDevice(undefined);
      setStaff(null);
      setSettingUp(false);
      setShowMenu(false);
      setNotice(message);
    },
    [store],
  );

  // The login ends at the next 05:00 event-local time (or the event end), also on a phone left open.
  useEffect(() => {
    if (!staff) return;
    const check = async () => {
      const d = deviceRef.current;
      const expiresAt = await sessionExpiresAt(store);
      if (d && expiresAt !== null && serverNow(d) >= expiresAt) {
        await clearSession(store);
        setStaff(null);
        setShowMenu(false);
        setNotice("Your login ended. Log in again.");
      }
    };
    const t = setInterval(() => void check(), SESSION_CHECK_MS);
    return () => clearInterval(t);
  }, [staff, store]);

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
          await clearSession(store).catch(() => undefined);
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

  const show = useCallback(
    (outcome: ScanOutcome) => {
      const view = resultView(outcome, { deviceId: deviceRef.current?.deviceId });
      feedback(view);
      setResult({ view, at: Date.now() });
      // This phone's own counts for the "Today" line.
      const d = deviceRef.current;
      const kind = outcome.kind === "admitted" ? "in" : outcome.kind === "exited" ? "out" : null;
      if (d && kind)
        void bumpCount(store, d, kind, serverNow(d))
          .then(setToday)
          .catch(() => undefined);
    },
    [store],
  );

  // Auto-dismiss: green 1.5 s, exit 1 s; the red and amber screens wait for "Next scan".
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
    setShowMenu(false);
    setNotice("Uploading queued scans…");
    const res = await setUpAgain(store, d, { supervisor });
    if (res.kind === "needs_supervisor") {
      setNotice("");
      setConfirmWipe(res.lost);
      return;
    }
    setConfirmWipe(null);
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
        setToday(
          await readCounts(store, next, serverNow(next)).catch(() => ({ day: 0, in: 0, out: 0 })),
        );
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
        setNotice("That is a setup code. Use “Set up this phone again” in the menu to use it.");
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
    await saveSession(store, d, session);
    setNotice("");
    setStaff(session);
  }

  async function signOut() {
    await clearSession(store);
    setShowMenu(false);
    setStaff(null);
  }

  if (!booted) {
    return (
      <main className="sc">
        <p>Loading…</p>
      </main>
    );
  }

  const phase = !device || !device.synced || settingUp ? "setup" : !staff ? "login" : "scan";

  return (
    <main className="sc" data-phase={phase}>
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
          waiting={outbox}
          notice={notice}
        />
      )}
      {phase === "scan" && device && staff && (
        <>
          {link === "offline" && (
            <div role="status" data-testid="offline-banner" className="sc-banner">
              OFFLINE · scans are saved on this phone and uploaded when the link is back
            </div>
          )}
          <Header
            device={device}
            staffName={staff.name}
            link={link}
            onMenu={() => setShowMenu(true)}
          />
          <DirectionToggle device={device} direction={direction} onChange={setDirection} />
          <Camera
            key={cameraKey}
            onCode={(raw) => void handleCode(raw)}
            paused={!!result || showSearch || showMenu}
          />
          {notice && (
            <p role="status" className="sc-notice">
              {notice}
            </p>
          )}
          <div className="sc-counts">
            <span data-testid="today">
              This phone today: {today.in} in · {today.out} out
            </span>
            <span data-testid="waiting">{outbox} waiting to upload</span>
          </div>
          <button type="button" className="sc-main-btn" onClick={() => setShowSearch(true)}>
            Find a ticket by name
          </button>
        </>
      )}
      {showMenu && device && (
        <MenuSheet
          device={device}
          waiting={outbox}
          installEvent={installEvent}
          onClose={() => setShowMenu(false)}
          onSwitchStaff={() => void signOut()}
          onSignOut={() => void signOut()}
          onRetryCamera={() => setCameraKey((n) => n + 1)}
          onEraseConfirmed={() =>
            void beginSetUpAgain().catch(() => setNotice("Could not set up again."))
          }
        />
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
      {result && device && (
        <ResultScreen
          view={result.view}
          context={`${device.gate} · ${directionLabel(device) === "Entry and exit" ? (direction === "entry" ? "Entry" : "Exit") : directionLabel(device)}`}
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
