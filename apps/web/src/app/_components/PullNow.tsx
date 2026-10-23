"use client";

import { useState } from "react";
import { api, ApiError, formatTime } from "../_lib/client";

interface Result {
  ok: boolean;
  changes: number;
  tickets: number;
  scans: number;
  message?: string;
  last_pull_at: number | null;
}

/** Hub dashboard: pull tickets, staff and settings from the VM now instead of waiting up to 30 s. */
export function PullNow() {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);

  async function pull() {
    setBusy(true);
    setText("");
    try {
      const r = await api<Result>("/api/hub/pull", { method: "POST", body: {} });
      setBad(!r.ok);
      setText(
        r.ok
          ? `Pulled ${r.changes} change${r.changes === 1 ? "" : "s"} from the VM.`
          : `${r.message ?? "VM not reachable."} Last successful pull: ${
              r.last_pull_at ? formatTime(r.last_pull_at) : "never"
            }.`,
      );
    } catch (err) {
      setBad(true);
      setText(err instanceof ApiError ? err.message : "Could not ask the hub to pull.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row" data-testid="pull-now">
      <button onClick={pull} disabled={busy}>
        {busy ? "Pulling…" : "Pull tickets now"}
      </button>
      {text && (
        <span role="status" className={bad ? "muted" : undefined} data-testid="pull-now-result">
          {text}
        </span>
      )}
    </div>
  );
}
