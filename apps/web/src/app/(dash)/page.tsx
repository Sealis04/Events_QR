"use client";

import { useEffect, useState } from "react";
import { Notice, Shell } from "../_components/Shell";
import { api, formatTime } from "../_lib/client";
import { RANK, type EventSummary, type Me } from "../_lib/types";

function EventList({ me }: { me: Me }) {
  const [events, setEvents] = useState<EventSummary[]>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<EventSummary[]>("/api/events")
      .then((list) => {
        // A hub serves exactly one event: go straight to it.
        if (me.mode === "hub" && list.length === 1) window.location.href = `/events/${list[0]!.id}`;
        else setEvents(list);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "failed to load"));
  }, [me.mode]);

  return (
    <>
      {error && <Notice tone="bad">{error}</Notice>}
      {me.mode === "hub" && events?.length === 0 && (
        <Notice tone="warn">This hub has not pulled its event from the VM yet.</Notice>
      )}
      <div className="card">
        <h2>Events</h2>
        {events?.length === 0 && me.mode === "server" && <p className="muted">No events yet.</p>}
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Venue</th>
                <th>Starts</th>
                <th>Gates</th>
              </tr>
            </thead>
            <tbody>
              {events?.map((ev) => (
                <tr key={ev.id}>
                  <td>
                    <a href={`/events/${ev.id}`}>{ev.name}</a>
                  </td>
                  <td>{ev.venue ?? "—"}</td>
                  <td>{formatTime(ev.starts_at)}</td>
                  <td>{ev.gates.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {me.role === "admin" && me.mode === "server" && (
        <a className="btn" href="/events/new">
          New event
        </a>
      )}
      {RANK[me.role] < RANK.admin && me.mode === "server" && (
        <p className="muted">Only admins can create events.</p>
      )}
    </>
  );
}

export default function Home() {
  return <Shell title="Events">{(me) => <EventList me={me} />}</Shell>;
}
