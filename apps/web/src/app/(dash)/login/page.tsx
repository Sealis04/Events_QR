"use client";

import { useState, type FormEvent } from "react";
import { api, ApiError } from "../../_lib/client";
import { noSessionMessage } from "../../_lib/loginHelp";

/** What went wrong, in words a gate-team lead can act on. */
function explain(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "That name and PIN do not match. Check both and try again.";
    if (err.status === 429) return "Too many tries. Wait a minute, then try again.";
    return err.message;
  }
  if (err instanceof TypeError)
    return "Cannot reach the server. Check the connection and try again.";
  return err instanceof Error ? err.message : "Login failed.";
}

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { body: { name: form.get("name"), pin: form.get("pin") } });
      // A venue hub only lets supervisors and admins in; plain staff pass the PIN check but get no session.
      await api("/api/auth/me").catch(() => {
        throw new Error(noSessionMessage(window.location));
      });
      window.location.href = "/";
    } catch (err) {
      setError(explain(err));
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <div className="card login-card">
        <h1 style={{ fontSize: 26 }}>Events QR</h1>
        <p className="muted" style={{ marginTop: 4 }}>
          Sign in to manage events and tickets.
        </p>
        <form className="grid" onSubmit={submit}>
          <label className="field">
            Name
            <input name="name" placeholder="Name" autoComplete="username" required />
          </label>
          <label className="field">
            PIN
            <input
              name="pin"
              className="keypad-input"
              type="password"
              inputMode="numeric"
              placeholder="PIN"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
            <div role="alert" className="notice bad" style={{ margin: 0 }}>
              {error}
            </div>
          )}
          <button type="submit" disabled={busy}>
            Log in
          </button>
        </form>
      </div>
    </main>
  );
}
