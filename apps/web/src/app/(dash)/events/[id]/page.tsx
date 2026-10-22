"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Notice, Shell } from "../../../_components/Shell";
import { api, ApiError, formatTime } from "../../../_lib/client";
import { RANK, type EventView, type Me, type Role } from "../../../_lib/types";
import { Admit } from "./_tabs/Admit";
import { Conflicts } from "./_tabs/Conflicts";
import { Devices } from "./_tabs/Devices";
import { Generator } from "./_tabs/Generator";
import { Live } from "./_tabs/Live";
import { Setup } from "./_tabs/Setup";
import { Tickets } from "./_tabs/Tickets";

interface TabDef {
  key: string;
  label: string;
  need: Role;
  /** Issuance, setup and cancellation live on the VM; the hub shows these disabled. */
  vmOnly?: boolean;
}

const TABS: TabDef[] = [
  { key: "generator", label: "QR generator", need: "staff", vmOnly: true },
  { key: "tickets", label: "Tickets", need: "staff" },
  { key: "live", label: "Live stats", need: "staff" },
  { key: "devices", label: "Devices", need: "supervisor" },
  { key: "conflicts", label: "Conflicts", need: "supervisor" },
  { key: "admit", label: "Attendees & overrides", need: "supervisor" },
  { key: "setup", label: "Setup", need: "admin", vmOnly: true },
];

function Workspace({ me, id }: { me: Me; id: string }) {
  const hub = me.mode === "hub";
  const [event, setEvent] = useState<EventView>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<string>(hub ? "live" : "generator");
  const [issuedCount, setIssuedCount] = useState(0);

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t) setTab(t);
  }, []);

  const load = useCallback(async () => {
    try {
      setEvent(await api<EventView>(`/api/events/${id}`));
      setError("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) window.location.href = "/login";
      else setError(err instanceof Error ? err.message : "failed to load");
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const visible = TABS.filter((t) => RANK[me.role] >= RANK[t.need]);
  const current = visible.find((t) => t.key === tab) ?? visible[0]!;

  let body: ReactNode = null;
  if (event) {
    if (hub && current.vmOnly) {
      body = (
        <Notice tone="warn">
          {current.label} is only available on the VM. The venue hub shows the live event and keeps
          admitting without internet; issuance, setup and cancellation wait for the VM.
        </Notice>
      );
    } else if (current.key === "generator") {
      body = (
        <Generator
          event={event}
          me={me}
          onIssued={() => {
            setIssuedCount((n) => n + 1);
            void load();
          }}
        />
      );
    } else if (current.key === "tickets")
      body = <Tickets event={event} me={me} refreshKey={issuedCount} />;
    else if (current.key === "live") body = <Live event={event} />;
    else if (current.key === "devices") body = <Devices event={event} me={me} />;
    else if (current.key === "conflicts") body = <Conflicts eventId={event.id} me={me} />;
    else if (current.key === "admit") body = <Admit event={event} />;
    else if (current.key === "setup") body = <Setup event={event} onChanged={() => void load()} />;
  }

  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {event && (
        <p className="muted" data-testid="event-meta">
          <strong>{event.name}</strong> · {event.venue ?? "no venue"} ·{" "}
          {formatTime(event.starts_at)} – {formatTime(event.ends_at)} · gates:{" "}
          {event.gates.join(", ")}
        </p>
      )}
      {hub && (
        <Notice tone="warn">
          You are on the venue hub. Stats, devices, conflicts and attendee search work without
          internet; issuance, setup and cancellation are VM-only.
        </Notice>
      )}
      <nav className="tabs" aria-label="Event sections">
        {TABS.filter((t) => RANK[me.role] >= RANK[t.need]).map((t) =>
          hub && t.vmOnly ? (
            <span
              key={t.key}
              className="disabled"
              title="Available on the VM only"
              aria-disabled="true"
            >
              {t.label}
            </span>
          ) : (
            <a
              key={t.key}
              href={`?tab=${t.key}`}
              aria-current={current.key === t.key ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                setTab(t.key);
                window.history.replaceState(null, "", `?tab=${t.key}`);
              }}
            >
              {t.label}
            </a>
          ),
        )}
      </nav>
      {body}
    </>
  );
}

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <Shell title="Event" back={{ href: "/", label: "Events" }}>
      {(me) => <Workspace me={me} id={id} />}
    </Shell>
  );
}
