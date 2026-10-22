# Handoff — m4-hub

Goal: the venue hub. One box at the venue that every gate's phone asks "first time for this ticket?", working with no internet, and syncing with the VM whenever it can.

Key constraints: the hub never holds the signing secret; its API must match the VM's scanner-facing API exactly so the scanner just switches URL; every sync write is idempotent.

Read in order: `CLAUDE.md`, `plans/m4-hub/inbox/builder-1.md`, the M4 section and "Hub HTTPS and DNS" of `plans/offline-qr-ticketing/plan.md`, then the `docs/spec.md` sections named in the inbox.

Next after approval: the planner opens `m5-offline` (phones deciding alone when the hub is unreachable, outbox, offline PIN login).
