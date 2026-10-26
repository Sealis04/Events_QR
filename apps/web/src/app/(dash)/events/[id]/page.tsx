"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Notice, Shell } from "../../../_components/Shell";
import { PullNow } from "../../../_components/PullNow";
import { api, ApiError, eventDate } from "../../../_lib/client";
import { eventStatus } from "../../../_lib/status";
import { RANK, type EventView, type Me, type Role } from "../../../_lib/types";
import { Admit } from "./_tabs/Admit";
import { Conflicts } from "./_tabs/Conflicts";
import { Devices } from "./_tabs/Devices";
import { Generator } from "./_tabs/Generator";
import { HubSetup } from "./_tabs/HubSetup";
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
  { key: "generator", label: "Issue tickets", need: "staff", vmOnly: true },
  { key: "tickets", label: "Tickets", need: "staff" },
  { key: "live", label: "Live stats", need: "staff" },
  { key: "devices", label: "Devices", need: "supervisor" },
  { key: "conflicts", label: "Conflicts", need: "supervisor" },
  { key: "admit", label: "Attendees & overrides", need: "supervisor" },
  { key: "hub-setup", label: "Hub setup", need: "admin" },
  { key: "setup", label: "Setup", need: "admin", vmOnly: true },
];

function Header({ event }: { event: EventView }) {
  const status = eventStatus(
    {
      starts_at: event.starts_at,
      ends_at: event.ends_at,
      ticket_type_count: event.ticket_types.length,
    },
    Math.floor(Date.now() / 1000),
  );
  return (
    <header className="event-head">
      <div className="row">
        <h1>{event.name}</h1>
        <span className={`tag ${status.tone}`}>
          {status.key === "live" && <span className="dot" />}
          {status.label}
        </span>
      </div>
      <p className="muted" data-testid="event-meta">
        <strong className="sr-only">{event.name} · </strong>
        {event.venue ?? "no venue"} · {eventDate(event.starts_at, event.timezone, true)} –{" "}
        {eventDate(event.ends_at, event.timezone, true)} · gates: {event.gates.join(", ")}
      </p>
    </header>
  );
}

function Workspace({ me, id }: { me: Me; id: string }) {
  const hub = me.mode === "hub";
  const [event, setEvent] = useState<EventView>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<string>(hub ? "live" : "generator");
  const [issuedCount, setIssuedCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);

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

  // Open double admissions, for the badge on the Conflicts tab.
  useEffect(() => {
    if (RANK[me.role] < RANK.supervisor) return;
    let stop = false;
    const poll = async () => {
      try {
        const res = await api<{ conflicts: { reviewed_at?: number | null }[] }>(
          `/api/events/${id}/conflicts?limit=200`,
        );
        if (!stop) setConflictCount(res.conflicts.filter((c) => !c.reviewed_at).length);
      } catch {
        /* the tab itself shows errors */
      }
    };
    void poll();
    const timer = setInterval(poll, 30_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [id, me.role]);

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
    else if (current.key === "hub-setup") body = <HubSetup event={event} me={me} />;
    else if (current.key === "setup") body = <Setup event={event} onChanged={() => void load()} />;
  }

  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {event && <Header event={event} />}
      {hub && (
        <Notice tone="warn">
          You are on the venue hub. Stats, devices, conflicts and attendee search work without
          internet; issuance, setup and cancellation are VM-only.
        </Notice>
      )}
      {hub && <PullNow />}
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
              {t.key === "conflicts" && conflictCount > 0 && (
                <span className="badge" aria-label={`${conflictCount} open`}>
                  {conflictCount}
                </span>
              )}
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
    <Shell back={{ href: "/", label: "Events" }}>{(me) => <Workspace me={me} id={id} />}</Shell>
  );
}
