"use client";

import { useEffect, useState } from "react";
import { Notice } from "../../../../_components/Shell";
import { api } from "../../../../_lib/client";
import type { EventView } from "../../../../_lib/types";
import { hhmm } from "./format";

interface Stats {
  total_admitted: number;
  inside: number;
  by_gate: Record<string, number>;
  by_ticket_type: Record<string, number>;
  conflicts: number;
  scans_per_minute: { minute: number; count: number }[];
  left?: number;
  last_minute?: number;
  busiest?: { minute: number; count: number } | null;
  open_conflicts?: number;
  hub?: { online: boolean; last_sync_at: number | null; last_error: string | null };
}

const POLL_MS = 5000;
/** After this long without an answer the page says the numbers are old. */
const STALE_AFTER_S = 30;

/** One point per minute for the last 60 minutes, zeros filled in. */
function series(stats: Stats, now: number) {
  const end = Math.floor(now / 60) * 60;
  const byMinute = new Map(stats.scans_per_minute.map((m) => [m.minute, m.count]));
  return Array.from({ length: 60 }, (_, i) => {
    const minute = end - (59 - i) * 60;
    return { minute, count: byMinute.get(minute) ?? 0 };
  });
}

/** Bars for the last hour. With no scans it says so instead of drawing an empty chart. */
function Bars({
  points,
  timezone,
}: {
  points: { minute: number; count: number }[];
  timezone: string;
}) {
  const max = Math.max(...points.map((p) => p.count));
  if (max === 0)
    return (
      <div className="empty" data-testid="no-scans">
        <strong>No scans yet</strong>
        Entries will show up here minute by minute.
      </div>
    );
  return (
    <div>
      <div
        role="img"
        aria-label={`Entries per minute, last 60 minutes, peak ${max} a minute`}
        style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120 }}
      >
        {points.map((p) => (
          <div
            key={p.minute}
            title={`${hhmm(p.minute, timezone)}: ${p.count}`}
            style={{
              flex: 1,
              height: p.count === 0 ? 2 : `${Math.max(4, (p.count / max) * 100)}%`,
              background: p.count === 0 ? "#e8ecf3" : "var(--accent)",
              borderRadius: 2,
            }}
          />
        ))}
      </div>
      <div className="row muted small" style={{ justifyContent: "space-between", marginTop: 4 }}>
        <span>{hhmm(points[0]!.minute, timezone)}</span>
        <span>peak {max} a minute</span>
        <span>{hhmm(points[points.length - 1]!.minute + 60, timezone)}</span>
      </div>
    </div>
  );
}

const pct = (n: number, of: number) => Math.round((n / of) * 100);

/** Refreshes every 5 s. */
export function Live({
  event,
  onOpenConflicts,
}: {
  event: EventView;
  onOpenConflicts?: () => void;
}) {
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const [lastOk, setLastOk] = useState<number>();
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<Stats>(`/api/events/${event.id}/stats`);
        if (stop) return;
        setStats(s);
        setLastOk(Math.floor(Date.now() / 1000));
        setError("");
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "failed to load");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      stop = true;
      clearInterval(timer);
      clearInterval(clock);
    };
  }, [event.id]);

  if (!stats) return <p>{error || "Loading…"}</p>;
  const tz = event.timezone;
  const caps = event.ticket_types.map((t) => t.capacity);
  const capacity = caps.every((c): c is number => c !== null)
    ? caps.reduce((a, b) => a + b, 0)
    : null;
  const maxGate = Math.max(1, ...Object.values(stats.by_gate));
  const age = lastOk === undefined ? 0 : Math.max(0, now - lastOk);
  const stale = error !== "" && age >= STALE_AFTER_S;
  const open = stats.open_conflicts ?? stats.conflicts;
  return (
    <div data-testid="live">
      {stats.hub && !stats.hub.online && (
        <Notice tone="warn">
          Hub has no internet
          {stats.hub.last_sync_at ? ` since ${hhmm(stats.hub.last_sync_at, tz)}` : ""} · scans still
          work, the VM catches up later.
        </Notice>
      )}
      {stale && (
        <Notice tone="bad">
          Not updating: no answer for {age} s ({error}). The numbers below are old.
        </Notice>
      )}
      <p className="muted small" style={{ marginTop: 0 }} data-testid="updated">
        {lastOk === undefined ? "Loading…" : `Updated ${age} s ago`}
      </p>

      <div className="tiles">
        <div className="tile">
          <span className="label">Inside now</span>
          <span className="stat">
            <span data-testid="stat-inside">{stats.inside}</span>
            {capacity !== null && (
              <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>
                {" "}
                of {capacity.toLocaleString()}
              </span>
            )}
          </span>
          {capacity !== null && capacity > 0 && (
            <div className="track">
              <div style={{ width: `${Math.min(100, pct(stats.inside, capacity))}%` }} />
            </div>
          )}
        </div>
        <div className="tile">
          <span className="label">Entered today</span>
          <span className="stat" data-testid="stat-total">
            {stats.total_admitted}
          </span>
          {stats.left !== undefined && <span className="muted small">{stats.left} have left</span>}
        </div>
        <div className="tile">
          <span className="label">Scans per minute</span>
          <span className="stat" data-testid="stat-rate">
            {stats.last_minute ?? 0}
          </span>
          <span className="muted small">
            {stats.busiest
              ? `busiest so far: ${stats.busiest.count} at ${hhmm(stats.busiest.minute, tz)}`
              : "no scans yet"}
          </span>
        </div>
        <div className={`tile${open > 0 ? " alert" : ""}`}>
          <span className="label">Needs a look</span>
          <span className="stat" data-testid="stat-conflicts">
            {open}
          </span>
          <a
            href="?tab=conflicts"
            onClick={(e) => {
              if (!onOpenConflicts) return;
              e.preventDefault();
              onOpenConflicts();
            }}
          >
            Conflicts to review →
          </a>
        </div>
      </div>

      <div className="cols">
        <div className="card">
          <h2>By gate</h2>
          {event.gates.map((g) => (
            <div key={g} style={{ marginBottom: 12 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{g}</span>
                <span>
                  <strong data-testid={`gate-${g}`}>{stats.by_gate[g] ?? 0}</strong> in
                </span>
              </div>
              <div className="track">
                <div style={{ width: `${((stats.by_gate[g] ?? 0) / maxGate) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h2>By ticket type</h2>
          {event.ticket_types.map((t) => {
            const n = stats.by_ticket_type[String(t.idx)] ?? 0;
            const of = t.capacity ?? t.issued;
            return (
              <div key={t.idx} style={{ marginBottom: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span>{t.name}</span>
                  <span data-testid={`type-${t.idx}`}>
                    <strong>{n}</strong> of{" "}
                    {t.capacity === null ? `${t.issued} issued` : t.capacity}
                    {of > 0 ? ` · ${pct(n, of)}%` : ""}
                  </span>
                </div>
                <div className="track">
                  <div style={{ width: `${of > 0 ? Math.min(100, pct(n, of)) : 0}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2 style={{ margin: 0 }}>Entries per minute, last hour</h2>
        </div>
        <div style={{ marginTop: 12 }}>
          <Bars points={series(stats, now)} timezone={tz} />
        </div>
      </div>
    </div>
  );
}
