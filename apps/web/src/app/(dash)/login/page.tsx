"use client";

import { useState, type FormEvent } from "react";
import { api } from "../../_lib/client";

export default function LoginPage() {
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api("/api/auth/login", { body: { name: form.get("name"), pin: form.get("pin") } });
      // A venue hub only lets supervisors and admins in; plain staff pass the PIN check but get no session.
      await api("/api/auth/me").catch(() => {
        throw new Error("This server only lets supervisors and admins into the dashboard.");
      });
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  return (
    <main className="page" style={{ maxWidth: 380 }}>
      <h1>Events QR</h1>
      <form className="grid card" onSubmit={submit}>
        <input name="name" placeholder="Name" autoComplete="username" required />
        <input
          name="pin"
          type="password"
          placeholder="PIN"
          autoComplete="current-password"
          required
        />
        <button type="submit">Log in</button>
        {error && (
          <div role="alert" className="notice bad">
            {error}
          </div>
        )}
      </form>
    </main>
  );
}
