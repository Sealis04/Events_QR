"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { api } from "../_lib/client";
import type { Me } from "../_lib/types";
import { useSession } from "../_lib/useSession";

export function Notice({ tone, children }: { tone: "warn" | "bad" | "ok"; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Shown instead of the page while a PIN change is required (too short for the role, or rotated after a lost phone). */
function ChangePin({ me, onDone }: { me: Me; onDone: () => void }) {
  const [error, setError] = useState("");
  const privileged = me.role !== "staff";
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get("new") !== f.get("again")) return setError("The two new PINs differ.");
    try {
      await api("/api/auth/change-pin", {
        body: { current_pin: f.get("current"), new_pin: f.get("new") },
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not change the PIN");
    }
  }
  return (
    <div className="card" style={{ maxWidth: 420 }}>
      <h2>Choose a new PIN</h2>
      <p className="muted">
        {me.pin_reset === "rotate"
          ? "A phone that may hold your PIN hash was reported lost. Pick a new PIN before continuing."
          : "Your PIN is too short for your role."}{" "}
        {privileged ? "Supervisor and admin PINs are at least 8 digits." : "At least 6 characters."}
      </p>
      <form className="grid" onSubmit={submit}>
        <label className="field">
          Current PIN
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label className="field">
          New PIN
          <input
            name="new"
            type="password"
            autoComplete="new-password"
            inputMode={privileged ? "numeric" : undefined}
            required
          />
        </label>
        <label className="field">
          New PIN again
          <input name="again" type="password" autoComplete="new-password" required />
        </label>
        {error && <Notice tone="bad">{error}</Notice>}
        <button type="submit">Change PIN</button>
      </form>
    </div>
  );
}

/** Page frame: title bar with who is logged in and which server answers; everything else waits for a valid PIN. */
export function Shell({
  title,
  back,
  actions,
  children,
}: {
  /** Page heading; leave out when the page draws its own `<h1>`. */
  title?: ReactNode;
  back?: { href: string; label: string };
  /** Buttons shown in the title bar next to who is logged in. */
  actions?: (me: Me) => ReactNode;
  children: (me: Me) => ReactNode;
}) {
  const { me, error, reload } = useSession();
  if (!me) return <main className="page">{error || "Loading…"}</main>;

  async function logout() {
    await api("/api/auth/logout", { body: {} });
    window.location.href = "/login";
  }
  return (
    <main className="page">
      <div className="topbar">
        <div>
          {back && (
            <a href={back.href} className="back">
              ← {back.label}
            </a>
          )}
          {title && <h1>{title}</h1>}
        </div>
        <div className="row">
          <span className={`tag ${me.mode === "hub" ? "warn" : ""}`} data-testid="server-mode">
            {me.mode === "hub" ? "Hub" : "VM"}
          </span>
          <span className="whoami" data-testid="who">
            {me.name} ({me.role})
          </span>
          {actions?.(me)}
          <button className="secondary" onClick={logout}>
            Log out
          </button>
        </div>
      </div>
      {me.pin_reset ? <ChangePin me={me} onDone={reload} /> : children(me)}
    </main>
  );
}
