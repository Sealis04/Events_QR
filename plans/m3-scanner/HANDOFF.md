# Handoff — m3-scanner

Goal: phones at the gate. A phone enrols by scanning a setup QR, then scans tickets, checks them locally (signature, event, gate, slot) and claims them on the VM. M4 moves the claim to the venue hub with the same API shape, and M5 adds offline mode, so keep the scanner's server URL and claim client swappable.

Do part A (the two user decisions) first; they are small and change M2 code.

Read in order: `CLAUDE.md`, `plans/m3-scanner/inbox/builder-1.md`, the M3 section of `plans/offline-qr-ticketing/plan.md`, then the `docs/spec.md` sections named in the inbox.

Next after approval: the planner opens `m4-hub`.
