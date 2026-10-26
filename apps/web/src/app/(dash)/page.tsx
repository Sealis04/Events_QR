"use client";

import { useEffect, useState } from "react";
import { Notice, Shell } from "../_components/Shell";
import { api, eventDate } from "../_lib/client";
import { eventStatus } from "../_lib/status";
import { RANK, type EventSummary, type Me } from "../_lib/types";

type Filter = "upcoming" | "ended" | "all";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "upcoming", label: "Upcoming and live" },
  { key: "ended", label: "Ended" },
  { key: "all", label: "All" },
];

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function EventCard({ ev, now }: { ev: EventSummary; now: number }) {
  const tz = ev.timezone || localZone();
  const status = eventStatus(ev, now);
  const sameDay = eventDate(ev.starts_at, tz) === eventDate(ev.ends_at, tz);
  const dates = sameDay
    ? eventDate(ev.starts_at, tz)
    : `${eventDate(ev.starts_at, tz)} – ${eventDate(ev.ends_at, tz)}`;
  const side =
    status.key === "live"
      ? `ends ${eventDate(ev.ends_at, tz, true)}`
      : status.key === "soon"
        ? `doors ${eventDate(ev.starts_at, tz, true)}`
        : status.key === "setup"
          ? "no tickets yet"
          : `ended ${eventDate(ev.ends_at, tz)}`;
  const phones = `${ev.device_count} phone${ev.device_count === 1 ? "" : "s"}`;
  const gates = `${ev.gates.length} gate${ev.gates.length === 1 ? "" : "s"}`;
  const live = status.key === "live";
  const count = live ? ev.inside : ev.issued;
  const pct = ev.capacity ? Math.min(100, Math.round((count / ev.capacity) * 100)) : 0;
  return (
    <a
      className="event-card"
      href={`/events/${ev.id}`}
      data-testid="event-card"
      data-status={status.key}
    >
      <div className="between">
        <span className={`tag ${status.tone}`}>
          {live && <span className="dot" />}
          {status.label}
        </span>
        <span className="small muted">{side}</span>
      </div>
      <div className="event-title">
        <span className="name">{ev.name}</span>
        <span className="muted small">{[ev.venue, dates].filter(Boolean).join(" · ")}</span>
      </div>
      {status.key === "setup" ? (
        <div className="small">Next: add ticket types</div>
      ) : (
        <div className="grid" style={{ gap: 6 }}>
          {ev.capacity ? (
            <div className="track" aria-hidden="true">
              <div style={{ width: `${pct}%`, background: live ? undefined : "#7c93c9" }} />
            </div>
          ) : null}
          <div className="between small">
            <span>
              <strong>{count.toLocaleString()}</strong> {live ? "inside" : "tickets issued"}
              {ev.capacity ? ` of ${ev.capacity.toLocaleString()}` : ""}
            </span>
            <span>{live ? `${gates} · ${phones}` : gates}</span>
          </div>
        </div>
      )}
    </a>
  );
}

function EventList({ me }: { me: Me }) {
  const [events, setEvents] = useState<EventSummary[]>();
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("upcoming");
  const now = Math.floor(Date.now() / 1000);
  useEffect(() => {
    api<EventSummary[]>("/api/events")
      .then((list) => {
        // A hub serves exactly one event: go straight to it.
        if (me.mode === "hub" && list.length === 1) window.location.href = `/events/${list[0]!.id}`;
        else setEvents(list);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load"));
  }, [me.mode]);

  const shown = events?.filter((ev) => {
    const ended = now > ev.ends_at;
    return filter === "all" || (filter === "ended" ? ended : !ended);
  });
  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {me.mode === "hub" && events?.length === 0 && (
        <Notice tone="warn">This hub has not pulled its event from the VM yet.</Notice>
      )}
      <div className="chips" role="group" aria-label="Show events">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="chip"
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      {shown?.length === 0 && me.mode === "server" && (
        <div className="empty">
          <strong>{events?.length ? "No events in this view." : "No events yet."}</strong>
          {RANK[me.role] < RANK.admin
            ? "Only admins can create events."
            : events?.length
              ? "Try the Ended or All filter."
              : "Create the first one with + New event."}
        </div>
      )}
      <div className="event-grid">
        {shown?.map((ev) => (
          <EventCard key={ev.id} ev={ev} now={now} />
        ))}
      </div>
    </>
  );
}

export default function Home() {
  return (
    <Shell
      title="Events"
      actions={(me) =>
        me.role === "admin" && me.mode === "server" ? (
          <a className="btn" href="/events/new">
            + New event
          </a>
        ) : null
      }
    >
      {(me) => <EventList me={me} />}
    </Shell>
  );
}
