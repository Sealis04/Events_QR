"use client";

import { fixFor, type HubCheckStep } from "@events-qr/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Notice } from "../../../../_components/Shell";
import { api, ApiError, formatTime } from "../../../../_lib/client";
import {
  fetchHealth,
  guessHubAddress,
  hostOf,
  hubUrlWarningText,
  STEPS,
  type StepDef,
} from "../../../../_lib/hubSetup";
import type { EventView, Me } from "../../../../_lib/types";

interface CheckRecord {
  id: string;
  step: HubCheckStep;
  result: "pass" | "warn" | "fail" | "skipped";
  code: string | null;
  summary: string;
  details: Record<string, string | number | boolean | null> | null;
  checked_at: number;
  checked_by_name: string | null;
  source: "vm" | "hub";
  device_id: string | null;
}
interface View {
  mode: "server" | "hub";
  now: number;
  hub_url: string | null;
  hub_url_warning?: { status: "unset" | "local"; value: string | null } | null;
  vm_url: string | null;
  pull_interval_seconds: number;
  hubs: { id: string; label: string | null; revoked: boolean }[];
  checks: CheckRecord[];
  history: CheckRecord[];
  hub_only_steps?: HubCheckStep[];
  vm_only_steps?: HubCheckStep[];
  offline_test_started_at: number | null;
  uplink?: { online: boolean; last_sync_at: number | null };
}

/** Steps that look the hub up by its address. */
const NEEDS_ADDRESS = new Set<HubCheckStep>([
  "hub_running",
  "dns_record",
  "certificate",
  "local_dns",
]);

const TAGS = {
  pass: { tone: "ok", label: "Passed" },
  warn: { tone: "warn", label: "Passed with a warning" },
  fail: { tone: "bad", label: "Failed" },
  skipped: { tone: "info", label: "Skipped" },
} as const;

const SHOWN_DETAILS: Record<string, string> = {
  addresses: "Addresses",
  expires_at: "Expires",
  days_left: "Days left",
  hub_tickets: "Tickets on the hub",
  vm_tickets: "Tickets on the VM",
  hub_staff: "Staff on the hub",
  vm_staff: "Staff on the VM",
  last_pull_at: "Last pull",
  last_seen_at: "Last seen",
  phones: "Phones",
  recent: "Recent",
  phone: "Latest phone",
  outage_from: "Uplink down from",
  outage_to: "Back at",
  scan_received_at: "Scan on the hub",
  vm_received_at: "VM received it",
  mode: "Mode",
  checked_by: "Measured by",
};
const TIME_DETAILS = new Set([
  "expires_at",
  "last_pull_at",
  "last_seen_at",
  "outage_from",
  "outage_to",
  "scan_received_at",
  "vm_received_at",
]);

/** A command with a copy button. Wraps long lines instead of scrolling sideways. */
function Cmd({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="cmd">
      <code>{text}</code>
      <button type="button" className="secondary small" onClick={copy} aria-label={`Copy ${label}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function Details({ record }: { record: CheckRecord }) {
  const rows = Object.entries(record.details ?? {}).filter(
    ([k, v]) => SHOWN_DETAILS[k] && v !== null && v !== "",
  );
  if (rows.length === 0) return null;
  return (
    <dl className="kv small">
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{SHOWN_DETAILS[k]}</dt>
          <dd>{TIME_DETAILS.has(k) && typeof v === "number" ? formatTime(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Result({ record }: { record: CheckRecord }) {
  const fix = fixFor(record.code);
  const showFix = record.result !== "pass" && fix;
  return (
    <div
      className={`step-result ${TAGS[record.result].tone}`}
      data-testid="step-result"
      data-code={record.code ?? ""}
    >
      <p>
        <strong>{record.summary}</strong>
      </p>
      <Details record={record} />
      {showFix && (
        <p className="fix" data-testid="step-fix">
          <strong>What to do: </strong>
          {fix.text}{" "}
          {fix.url && (
            <a href={fix.url} target="_blank" rel="noreferrer">
              Setup guide {fix.section}
            </a>
          )}
        </p>
      )}
      <p className="small muted">
        {record.result === "skipped" ? "Not recorded. " : ""}Checked {formatTime(record.checked_at)}
        {record.checked_by_name ? ` by ${record.checked_by_name}` : ""}
        {record.result === "skipped" ? "" : record.source === "hub" ? " on the hub" : " on the VM"}
      </p>
    </div>
  );
}

export function HubSetup({ event, me }: { event: EventView; me: Me }) {
  const [view, setView] = useState<View>();
  const [error, setError] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState<HubCheckStep | "">("");
  const [local, setLocal] = useState<Partial<Record<HubCheckStep, CheckRecord>>>({});
  const [code, setCode] = useState<{ code: string; expiresAt: number }>();
  const hub = me.mode === "hub";
  const storeKey = `eqr.hub-address.${event.id}`;

  const load = useCallback(async () => {
    try {
      const v = await api<View>(`/api/events/${event.id}/hub-setup`);
      setView(v);
      setError("");
      return v;
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [event.id]);

  useEffect(() => {
    void load().then((v) => {
      let saved = "";
      try {
        saved = localStorage.getItem(storeKey) ?? "";
      } catch {
        /* private window: no remembered address */
      }
      setAddress(
        saved ||
          v?.hub_url ||
          (hub ? window.location.origin : guessHubAddress(window.location.hostname)),
      );
    });
  }, [load, storeKey, hub]);

  // Results made on the hub arrive here with its next sync: keep the record fresh while the page is open.
  useEffect(() => {
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);

  function changeAddress(value: string) {
    setAddress(value);
    try {
      localStorage.setItem(storeKey, value);
    } catch {
      /* not remembered */
    }
  }

  const latest = useMemo(() => {
    const map = new Map<HubCheckStep, CheckRecord>();
    for (const c of view?.checks ?? []) map.set(c.step, c);
    return map;
  }, [view]);
  const shown = (step: HubCheckStep): CheckRecord | undefined => {
    const l = local[step];
    const s = latest.get(step);
    return l && (!s || l.checked_at >= s.checked_at) ? l : s;
  };

  const vmOnly = useMemo(() => new Set(view?.vm_only_steps ?? []), [view]);
  const hubOnly = useMemo(() => new Set(view?.hub_only_steps ?? []), [view]);
  const passed = STEPS.filter((s) => {
    const r = latest.get(s.key)?.result;
    return r === "pass" || r === "warn";
  }).length;
  const lastChecked = (view?.checks ?? []).reduce((m, c) => Math.max(m, c.checked_at), 0);

  async function post(step: HubCheckStep, extra: Record<string, unknown> = {}) {
    setBusy(step);
    setError("");
    try {
      const res = await api<{ check: CheckRecord; stored: boolean }>(
        `/api/events/${event.id}/hub-setup/checks`,
        { body: { step, ...extra } },
      );
      setLocal((prev) => ({ ...prev, [step]: res.check }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "check failed");
    } finally {
      setBusy("");
    }
  }

  async function check(step: HubCheckStep) {
    if (step === "hub_running" || step === "local_dns")
      return post(step, { fetch: await fetchHealth(address) });
    if (step === "certificate") {
      const f = await fetchHealth(address);
      const body = (f.body ?? {}) as { cert_expires_at?: unknown };
      return post(step, {
        address,
        browser: {
          reached_over_https: f.reached && f.url.startsWith("https://"),
          cert_expires_at: typeof body.cert_expires_at === "number" ? body.cert_expires_at : null,
        },
      });
    }
    if (step === "dns_record") return post(step, { address });
    return post(step);
  }

  async function makeCode() {
    setBusy("link_hub");
    try {
      const res = await api<{ setup_code: string; expires_at: number }>("/api/hubs/setup", {
        body: { event_id: event.id, label: "Venue hub" },
      });
      setCode({ code: res.setup_code, expiresAt: res.expires_at });
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not make a code");
    } finally {
      setBusy("");
    }
  }

  const host = hostOf(address);
  const vmUrl = view?.vm_url ?? (typeof window === "undefined" ? "" : window.location.origin);
  const lanIp = String(latest.get("dns_record")?.details?.addresses ?? "")
    .split(",")[0]
    ?.trim();
  const hubDashboard = address
    ? `${/^https?:\/\//i.test(address) ? address.replace(/\/+$/, "") : `https://${address}`}/events/${event.id}?tab=hub-setup`
    : "";

  function extras(step: StepDef) {
    switch (step.key) {
      case "phone_via_hub":
        return view?.hub_url_warning ? (
          <Notice tone="bad">{hubUrlWarningText(view.hub_url_warning)}</Notice>
        ) : null;
      case "hub_running":
        return (
          <>
            <p className="small muted">On the hub machine, in the repository folder:</p>
            <Cmd
              label="the hub status command"
              text="docker compose --env-file .env -f docker/compose.hub.yml ps"
            />
          </>
        );
      case "dns_record":
        return host ? (
          <>
            <p className="small muted">To look at the record yourself:</p>
            <Cmd label="the DNS command" text={`nslookup ${host} 1.1.1.1`} />
          </>
        ) : null;
      case "certificate":
        return host ? (
          <>
            <p className="small muted">
              To read the expiry date from any machine that can reach the hub:
            </p>
            <Cmd
              label="the openssl command"
              text={`openssl s_client -connect ${host}:443 -servername ${host} </dev/null 2>/dev/null | openssl x509 -noout -enddate`}
            />
          </>
        ) : null;
      case "link_hub":
        return (
          <>
            <div className="row">
              <button type="button" className="secondary" onClick={makeCode} disabled={busy !== ""}>
                Make a setup code
              </button>
              {code && (
                <span className="small muted">
                  valid until {formatTime(code.expiresAt)} (10 minutes, used once)
                </span>
              )}
            </div>
            {code ? (
              <>
                <p className="small" style={{ margin: 0 }}>
                  Enter this code on the hub&apos;s setup page (<code>/setup</code> on the hub).
                </p>
                <Cmd label="the setup code" text={code.code} />
                <p className="small muted" style={{ margin: 0 }}>
                  No browser at the hub? Run this on the hub machine instead:
                </p>
                <Cmd
                  label="the hub-enroll command"
                  text={`docker compose --env-file .env -f docker/compose.hub.yml run --rm tools bun scripts/hub-enroll.ts ${vmUrl} ${code.code}`}
                />
              </>
            ) : (
              <p className="small muted">
                The code is made here and entered on the hub&apos;s setup page.
              </p>
            )}
          </>
        );
      case "local_dns":
        return host ? (
          <>
            <p className="small muted">
              This test only means something with the internet unplugged, or from a phone whose DNS
              server is the venue router. To ask the router (or the hub's own DNS service) directly:
            </p>
            <Cmd label="the router DNS command" text={`nslookup ${host} <router-ip>`} />
            {lanIp && <Cmd label="the hub DNS command" text={`nslookup ${host} ${lanIp}`} />}
          </>
        ) : null;
      case "offline_scan":
        return hub ? (
          <>
            <ol className="small steps-list">
              <li>Press “Start the offline test”.</li>
              <li>
                Unplug the cable between the venue router and the internet (not the hub&apos;s own
                cable).
              </li>
              <li>
                Wait one minute, then scan the rehearsal test ticket with a phone on the venue
                Wi-Fi.
              </li>
              <li>Plug the uplink back in, wait a minute, then press Check.</li>
            </ol>
            <div className="row">
              <button
                type="button"
                className="secondary"
                disabled={busy !== ""}
                onClick={() => post("offline_scan", { action: "start" })}
              >
                Start the offline test
              </button>
              {view?.offline_test_started_at && (
                <span className="small muted" data-testid="offline-started">
                  Started {formatTime(view.offline_test_started_at)}
                </span>
              )}
            </div>
          </>
        ) : null;
      default:
        return null;
    }
  }

  function card(step: StepDef, n: number) {
    const record = shown(step.key);
    const skipHere =
      (hub && (vmOnly.has(step.key) || step.runsOn === "vm")) ||
      (!hub && (hubOnly.has(step.key) || step.runsOn === "hub"));
    const tag = record ? TAGS[record.result] : undefined;
    return (
      <section
        key={step.key}
        className="card step"
        data-testid={`step-${step.key}`}
        data-result={record?.result ?? "none"}
      >
        <div className="step-head">
          <span className="num" aria-hidden="true">
            {n}
          </span>
          <h3>{step.title}</h3>
          {tag ? (
            <span className={`tag ${tag.tone}`}>{tag.label}</span>
          ) : (
            <span className="tag">Not checked</span>
          )}
        </div>
        <p className="muted">{step.blurb}</p>
        {extras(step)}
        {skipHere ? (
          <Notice tone="warn">
            {hub ? (
              <>
                This step needs the VM, so it is skipped on the hub. It is done from the VM&apos;s
                page{view?.vm_url ? ` (${view.vm_url})` : ""} while the hub has internet.
              </>
            ) : (
              <>
                This step looks at what the hub holds, so it runs on the hub&apos;s own dashboard
                {hubDashboard ? (
                  <>
                    : <a href={hubDashboard}>open the hub&apos;s Hub setup page</a> on the venue
                    Wi-Fi
                  </>
                ) : null}
                . The result is sent here with the hub&apos;s next sync.
              </>
            )}
          </Notice>
        ) : (
          <div className="row">
            <button
              type="button"
              onClick={() => void check(step.key)}
              disabled={busy !== "" || (NEEDS_ADDRESS.has(step.key) && !address.trim())}
              aria-label={`Check: ${step.title}`}
            >
              {busy === step.key ? "Checking…" : "Check"}
            </button>
          </div>
        )}
        {record && <Result record={record} />}
      </section>
    );
  }

  if (!view) return error ? <Notice tone="bad">{error}</Notice> : <p className="muted">Loading…</p>;

  return (
    <div data-testid="hub-setup">
      {error && <Notice tone="bad">{error}</Notice>}
      {view.hub_url_warning && (
        <div data-testid="hub-url-warning">
          <Notice tone="warn">{hubUrlWarningText(view.hub_url_warning)}</Notice>
        </div>
      )}
      <section className="card">
        <div className="between">
          <h2 style={{ margin: 0 }}>Hub setup</h2>
          <span className="small muted" data-testid="hub-progress">
            {passed} of {STEPS.length} passed
            {lastChecked ? `, last checked ${formatTime(lastChecked)}` : ""}
          </span>
        </div>
        <div className="progress" aria-hidden="true">
          {STEPS.map((s) => (
            <span key={s.key} className={latest.get(s.key)?.result ?? "none"} />
          ))}
        </div>
        <p className="muted">
          For the person setting up the venue hub. Do Part 1 at the office with internet, then Part
          2 at the venue. Every step has a Check button, and what passed is kept as the record that
          this hub was tested.
        </p>
        <label className="field">
          Hub address (what a browser types to reach the hub)
          <input
            value={address}
            onChange={(e) => changeAddress(e.target.value)}
            placeholder="https://hub.example.org"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </label>
      </section>

      <h2 className="part">Part 1 · At the office (needs internet)</h2>
      {STEPS.filter((s) => s.part === 1).map((s) => card(s, STEPS.indexOf(s) + 1))}

      <h2 className="part">Part 2 · At the venue (on the venue Wi-Fi)</h2>
      {hub && view.uplink && (
        <Notice tone={view.uplink.online ? "ok" : "warn"}>
          {view.uplink.online
            ? "The hub can reach the VM."
            : "The hub cannot reach the VM right now. Steps that need the VM are skipped."}
        </Notice>
      )}
      {STEPS.filter((s) => s.part === 2).map((s) => card(s, STEPS.indexOf(s) + 1))}

      <section className="card">
        <details>
          <summary>Record of checks ({view.history.length})</summary>
          {view.history.length === 0 ? (
            <p className="muted">Nothing has been checked yet.</p>
          ) : (
            <ul className="record-list">
              {view.history.map((h) => (
                <li key={h.id}>
                  <span className="small muted">{formatTime(h.checked_at)}</span>
                  <strong>{STEPS.find((s) => s.key === h.step)?.title}</strong>
                  <span className={`tag ${TAGS[h.result].tone}`}>{TAGS[h.result].label}</span>
                  <span className="small muted">
                    {h.checked_by_name ?? "-"} · on the {h.source === "hub" ? "hub" : "VM"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </section>
    </div>
  );
}
