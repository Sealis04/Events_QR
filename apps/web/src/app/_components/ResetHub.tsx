"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "../_lib/client";
import type { Me } from "../_lib/types";
import { Dialog } from "./Dialog";

interface Unsent {
  scans: number;
  devices: number;
  checks: number;
}
interface Status {
  event_name: string | null;
  unsent: Unsent;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Hub dashboard: wipe this hub back to the setup page after the event. Blocked while records wait to upload. */
export function ResetHub({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>();
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [after, setAfter] = useState(false);
  const admin = me.role === "admin";

  useEffect(() => {
    if (!open) return;
    setForce(false);
    setError("");
    api<Status>("/api/hub/status")
      .then(setStatus)
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load"));
  }, [open]);

  const unsent = status?.unsent;
  const waiting = unsent ? unsent.scans + unsent.devices + unsent.checks : 0;
  const blocked = waiting > 0 && !(admin && force);

  async function go() {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ revoked_on_server: boolean; message: string }>("/api/hub/reset", {
        body: waiting > 0 ? { force: true } : {},
      });
      if (res.revoked_on_server) window.location.href = "/setup";
      else {
        setOpen(false);
        setAfter(true);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Reset failed.");
      setBusy(false);
    }
  }

  if (after)
    return (
      <div role="alert" className="notice warn" data-testid="reset-revoke-note">
        This hub is reset, but the server could not be reached. Revoke this hub on the server: event
        → Devices → the hub → Revoke.{" "}
        <a className="btn" href="/setup">
          Go to setup
        </a>
      </div>
    );

  return (
    <div className="row" data-testid="reset-hub">
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        Reset hub
      </button>
      {open && (
        <Dialog
          title="Reset this hub?"
          onClose={() => !busy && setOpen(false)}
          actions={
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => setOpen(false)}
                data-autofocus
              >
                Keep it
              </button>
              <button
                type="button"
                className="danger"
                onClick={go}
                disabled={busy || !status || blocked}
                data-testid="reset-confirm"
              >
                Reset hub
              </button>
            </>
          }
        >
          <p style={{ margin: 0 }}>
            This deletes {status?.event_name ? `“${status.event_name}”` : "the event"} from this
            hub: its tickets, staff, phones, scans, setup checks and the hub&apos;s keys. Everyone
            is logged out and the hub goes back to the setup page. The server keeps its copy.
          </p>
          {unsent && (
            <div
              className={`notice ${waiting > 0 ? "warn" : "ok"}`}
              style={{ margin: 0 }}
              data-testid="reset-unsent"
            >
              {waiting > 0
                ? `Not yet uploaded to the server: ${plural(unsent.scans, "scan")}, ${plural(unsent.devices, "phone")}, ${plural(unsent.checks, "check")}. Wait until they reach zero.`
                : "Everything has been uploaded to the server."}
            </div>
          )}
          {waiting > 0 && admin && (
            <label className="check" style={{ alignItems: "flex-start" }}>
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                style={{ marginTop: 10 }}
              />
              <span>
                <strong>Delete them anyway</strong>
                <br />
                <span className="hint">
                  Those records are lost for good: they never reach the server.
                </span>
              </span>
            </label>
          )}
          {error && (
            <div role="alert" className="notice bad" style={{ margin: 0 }}>
              {error}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}
