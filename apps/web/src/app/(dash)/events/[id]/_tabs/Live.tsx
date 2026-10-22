"use client";

import { useEffect, useState } from "react";
import { Notice } from "../../../../_components/Shell";
import { api, formatClock } from "../../../../_lib/client";
import type { EventView } from "../../../../_lib/types";

interface Stats {
  total_admitted: number;
  inside: number;
  by_gate: Record<string, number>;
  by_ticket_type: Record<string, number>;
  conflicts: number;
  scans_per_minute: { minute: number; count: number }[];
}

/** One point per minute for the last 60 minutes, zeros filled in. */
function series(stats: Stats, now: number) {
  const end = Math.floor(now / 60) * 60;
  const byMinute = new Map(stats.scans_per_minute.map((m) => [m.minute, m.count]));
  return Array.from({ length: 60 }, (_, i) => {
    const minute = end - (59 - i) * 60;
    return { minute, count: byMinute.get(minute) ?? 0 };
  });
}

function Line({ points }: { points: { minute: number; count: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const w = 600;
  const h = 120;
  const path = points
    .map((p, i) => `${(i / (points.length - 1)) * w},${h - 8 - (p.count / max) * (h - 16)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="Scans per minute, last 60 minutes"
      style={{ width: "100%", height: 140 }}
    >
      <line x1="0" y1={h - 8} x2={w} y2={h - 8} stroke="currentColor" opacity="0.25" />
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={path} />
      <text x="4" y="14" fontSize="12" fill="currentColor">
        peak {max}/min
      </text>
    </svg>
  );
}

/** Refreshes every 5 s. */
export function Live({ event }: { event: EventView }) {
  const [stats, setStats] = useState<Stats>();
  const [error, setError] = useState("");
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const s = await api<Stats>(`/api/events/${event.id}/stats`);
        if (stop) return;
        setStats(s);
        setNow(Math.floor(Date.now() / 1000));
        setError("");
      } catch (err) {
        if (!stop) setError(err instanceof Error ? err.message : "failed to load");
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [event.id]);

  if (!stats) return <p>{error || "Loading…"}</p>;
  const maxGate = Math.max(1, ...Object.values(stats.by_gate));
  return (
    <div data-testid="live">
      {error && <Notice tone="bad">{error} (showing the last numbers)</Notice>}
      <div className="cols">
        <div className="card">
          <div className="muted">Checked in</div>
          <div className="stat" data-testid="stat-total">
            {stats.total_admitted}
          </div>
        </div>
        <div className="card">
          <div className="muted">Inside now</div>
          <div className="stat" data-testid="stat-inside">
            {stats.inside}
          </div>
        </div>
        <div className="card">
          <div className="muted">Conflicts</div>
          <div className="stat" data-testid="stat-conflicts">
            {stats.conflicts}
          </div>
        </div>
      </div>
      <div className="cols">
        <div className="card">
          <h3>Per gate</h3>
          {event.gates.map((g) => (
            <div key={g} style={{ marginBottom: 8 }}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span>{g}</span>
                <strong data-testid={`gate-${g}`}>{stats.by_gate[g] ?? 0}</strong>
              </div>
              <div
                className="bar"
                style={{ width: `${((stats.by_gate[g] ?? 0) / maxGate) * 100}%` }}
              />
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Per ticket type</h3>
          <table>
            <tbody>
              {event.ticket_types.map((t) => (
                <tr key={t.idx}>
                  <td>{t.name}</td>
                  <td data-testid={`type-${t.idx}`}>
                    {stats.by_ticket_type[String(t.idx)] ?? 0}/ {t.issued} issued
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <h3>Scans per minute (last 60 min)</h3>
        <Line points={series(stats, now)} />
        <p className="muted">Updated {formatClock(now)}, every 5 s.</p>
      </div>
    </div>
  );
}
