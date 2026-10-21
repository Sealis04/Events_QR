"use client";

import { useState, type FormEvent } from "react";
import { api } from "../_lib/client";

export default function LoginPage() {
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    try {
      await api("/api/auth/login", { body: { name: form.get("name"), pin: form.get("pin") } });
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    }
  }

  return (
    <main>
      <h1>Events QR</h1>
      <form onSubmit={submit} style={{ display: "grid", gap: 8, maxWidth: 320 }}>
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
          <p role="alert" style={{ color: "crimson" }}>
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
