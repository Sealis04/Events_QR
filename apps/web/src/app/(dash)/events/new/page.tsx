"use client";

import { EventForm } from "../../../_components/EventForm";
import { Notice, Shell } from "../../../_components/Shell";

export default function NewEventPage() {
  return (
    <Shell title="New event" back={{ href: "/", label: "Events" }}>
      {(me) =>
        me.mode === "hub" ? (
          <Notice tone="warn">Events are set up on the VM, not on the venue hub.</Notice>
        ) : me.role !== "admin" ? (
          <Notice tone="warn">Only admins can create events.</Notice>
        ) : (
          <EventForm
            defaultTimezone={me.default_timezone}
            onSaved={(id) => {
              window.location.href = `/events/${id}`;
            }}
          />
        )
      }
    </Shell>
  );
}
