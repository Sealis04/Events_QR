"use client";

import { useCallback, useEffect, useState } from "react";
import { Notice } from "../../../../_components/Shell";
import { api, formatTime } from "../../../../_lib/client";
import type { Me } from "../../../../_lib/types";

interface Side {
  gate: string;
  scanned_at: number;
  offline: boolean;
  device_label: string | null;
  device_id: string | null;
  staff_name: string | null;
}
interface Conflict {
  scan_id: string;
  ticket_id: string;
  holder_name: string | null;
  gate: string;
  device_id: string | null;
  scanned_at: number;
  offline: boolean;
  staff_name?: string | null;
  device_label?: string | null;
  canonical_detail?: Side | null;
  ticket_status: string;
  reviewed_at?: number | null;
}

const deviceName = (label: string | null | undefined, id: string | null) =>
  label ?? (id ? id.slice(0, 8) : "dashboard");

function Scan({ title, s }: { title: string; s: Side }) {
  return (
    <div>
      <strong>{title}</strong>
      <dl className="kv">
        <dt>Gate</dt>
        <dd>{s.gate}</dd>
        <dt>Device</dt>
        <dd>{deviceName(s.device_label, s.device_id)}</dd>
        <dt>Staff</dt>
        <dd>{s.staff_name ?? "—"}</dd>
        <dt>Time</dt>
        <dd>{formatTime(s.scanned_at)}</dd>
        <dt>Offline</dt>
        <dd>{s.offline ? "yes" : "no"}</dd>
      </dl>
    </div>
  );
}

/** Double admissions with both scans side by side. Refreshes every 10 s. */
export function Conflicts({ eventId, me }: { eventId: number; me: Me }) {
  const [items, setItems] = useState<Conflict[]>([]);
  const [total, setTotal] = useState(0);
  const [showReviewed, setShowReviewed] = useState(false);
  const [error, setError] = useState("");
  const hub = me.mode === "hub";

  const load = useCallback(async () => {
    try {
      const res = await api<{ conflicts: Conflict[]; total: number }>(
        `/api/events/${eventId}/conflicts?limit=200`,
      );
      setItems(res.conflicts);
      setTotal(res.total);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [eventId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  async function review(c: Conflict, reviewed: boolean) {
    try {
      await api(`/api/scans/${c.scan_id}/review`, { body: { reviewed } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed");
    }
  }

  const shown = items.filter((c) => showReviewed || !c.reviewed_at);
  return (
    <div data-testid="conflicts">
      {hub && (
        <Notice tone="warn">
          On the hub the feed is read-only. Mark conflicts as reviewed on the VM.
        </Notice>
      )}
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="row" style={{ marginBottom: 14, justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>
          {total} conflict{total === 1 ? "" : "s"}
        </h2>
        <label className="check">
          <input
            type="checkbox"
            checked={showReviewed}
            onChange={(e) => setShowReviewed(e.target.checked)}
          />
          Show reviewed
        </label>
      </div>
      {shown.length === 0 && (
        <div className="card empty">
          <strong>Nothing to review</strong>
          Two scans of one ticket, for example from phones that were offline, show up here with both
          sides next to each other.
        </div>
      )}
      {shown.map((c) => (
        <div className="card" key={c.scan_id} data-testid="conflict">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{c.holder_name ?? c.ticket_id.slice(-6).toUpperCase()}</strong>
            <span className="row">
              <span className="tag">{c.ticket_status.replace("_", " ")}</span>
              {c.reviewed_at ? <span className="tag ok">reviewed</span> : null}
            </span>
          </div>
          <div className="versus" style={{ margin: "8px 0" }}>
            {c.canonical_detail ? (
              <Scan title="Stays valid (first)" s={c.canonical_detail} />
            ) : (
              <div>
                <strong>Stays valid</strong>
                <p className="muted">The ticket was cancelled before this scan.</p>
              </div>
            )}
            <Scan
              title="Flagged (later)"
              s={{
                gate: c.gate,
                scanned_at: c.scanned_at,
                offline: c.offline,
                device_label: c.device_label ?? null,
                device_id: c.device_id,
                staff_name: c.staff_name ?? null,
              }}
            />
          </div>
          {!hub && (
            <button className="secondary small" onClick={() => review(c, !c.reviewed_at)}>
              {c.reviewed_at ? "Mark as not reviewed" : "Mark reviewed"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
