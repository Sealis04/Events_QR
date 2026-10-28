"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "../_lib/client";

interface Linked {
  event_id: number;
  event_name: string | null;
  tickets: number;
}

/** What went wrong, in words the person at the hub can act on. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 && err.code === "already_linked") return "This hub is already linked.";
    return err.message;
  }
  if (err instanceof TypeError) return "Cannot reach this hub. Check the connection and try again.";
  return err instanceof Error ? err.message : "Linking failed.";
}

export function SetupCard({ serverUrl }: { serverUrl: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [linked, setLinked] = useState<Linked>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    setBusy(true);
    setError("");
    try {
      setLinked(await api<Linked>("/api/hub/link", { body: { code } }));
    } catch (err) {
      setError(explain(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="card login-card" data-testid="setup-card">
        <h1 style={{ fontSize: 26 }}>Set up this hub</h1>
        {linked ? (
          <div className="grid">
            <div role="status" className="notice ok" style={{ margin: 0 }} data-testid="setup-done">
              Linked to {linked.event_name ?? `event ${linked.event_id}`}:{" "}
              {linked.tickets.toLocaleString()} ticket{linked.tickets === 1 ? "" : "s"}.
            </div>
            <a className="btn" href="/login">
              Log in
            </a>
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 4 }}>
              Link this hub to an event with a setup code.
            </p>
            <form className="grid" onSubmit={submit}>
              <label className="field">
                Server address
                <input
                  value={serverUrl ?? ""}
                  placeholder="Not set"
                  readOnly
                  aria-readonly="true"
                  data-testid="setup-server"
                />
              </label>
              <label className="field">
                Setup code
                <input
                  name="code"
                  placeholder="Setup code"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                  disabled={busy || !serverUrl}
                />
              </label>
              {!serverUrl && (
                <div role="alert" className="notice bad" style={{ margin: 0 }}>
                  This hub has no server address. Set HUB_SERVER_URL in its .env and restart it.
                </div>
              )}
              {error && (
                <div
                  role="alert"
                  className="notice bad"
                  style={{ margin: 0 }}
                  data-testid="setup-error"
                >
                  {error}
                </div>
              )}
              {busy && (
                <div role="status" className="muted small">
                  Linking… pulling tickets and staff
                </div>
              )}
              <button type="submit" disabled={busy || !serverUrl}>
                Link hub
              </button>
            </form>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Get a code on the server: open the event, then the Hub setup tab. A code works once
              and lasts 10 minutes.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
