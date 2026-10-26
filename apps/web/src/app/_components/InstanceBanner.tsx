"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "events-qr:instance-label";

/**
 * A red bar on every page of a non-production copy (INSTANCE_LABEL, e.g. "TEST"), so nobody runs a
 * real gate on the test copy or generates real tickets there. The label comes from /api/health and
 * is remembered, so the scanner keeps showing it while offline.
 */
export function InstanceBanner() {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    try {
      setLabel(localStorage.getItem(STORAGE_KEY));
    } catch {
      // storage blocked: rely on the network answer
    }
    let cancelled = false;
    fetch("/api/health", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { instance_label?: string } | null) => {
        if (cancelled || !body) return;
        const next = body.instance_label ?? null;
        setLabel(next);
        try {
          if (next) localStorage.setItem(STORAGE_KEY, next);
          else localStorage.removeItem(STORAGE_KEY);
        } catch {
          // ignore
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (!label) return null;
  return (
    <div
      role="status"
      data-testid="instance-banner"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 1000,
        background: "#b91c1c",
        color: "#fff",
        font: "600 13px/1.4 system-ui, sans-serif",
        textAlign: "center",
        padding: "4px 8px",
        letterSpacing: "0.04em",
      }}
    >
      {label.toUpperCase()} COPY: not for real events. Tickets made here do not work at real gates.
    </div>
  );
}
