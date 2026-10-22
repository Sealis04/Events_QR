# builder-1 — m6-dashboard

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M6 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M6 from `plans/offline-qr-ticketing/plan.md`: the admin dashboard, plus a user decision and two reviewer findings. Spec sections in `docs/spec.md`: "Admin dashboard and event-day operations" (dashboard features, runbook, failure modes), "Event setup and QR generator" (steps 1–2, generator actions), "Security" (data retention), "Ticket issuance and delivery". The plan wins over the spec.

### A. Security items (do these first)

1. **Longer PINs for supervisors and admins (user decision 2026-10-22).** Supervisor and admin PINs must be at least 8 digits; staff PINs stay at the current minimum. Enforce on create and on change (`scripts/create-admin.ts` too). Use slower argon2id settings for supervisor/admin hashes (and for every hash sent to phones), tuned so a phone still verifies in under ~1 s. Existing short supervisor/admin PINs must be changed at next login before anything else works. Tests for each rule.
2. **Sealis04/Events_QR#8:** phones (and the hub) receive PIN hashes only for staff assigned to that event, and stop receiving them after the event ends; when a staff member is removed from the event the next sync deletes their hash from the phone. Add per-event staff assignment (admin UI + API) — default: every staff member who issued tickets or is explicitly added. Reference #8 in the commit.
3. **Sealis04/Events_QR#9:** backfill `tickets.cancelled_at` for tickets cancelled before M5 (use `updated_at`) in a migration or one-off script that runs with the migrations; idempotent. Reference #9.
4. **Lost-phone runbook step:** a "Revoke and rotate" action on the Devices page that revokes the device and forces PIN changes for the staff whose hashes were on it.

### B. Dashboard (M6)

5. **Event workspace** (replace the plain M2 admin pages): event list; event setup (name, dates and doors, venue, gates in fixed order, ticket types with capacity, entry rule, allowed gates, time slots, early-entry 15–30 min); per-event tabs for QR generator, ticket list, devices, live stats, conflicts.
6. **QR generator UI** exactly as the spec's step 2: holder name, type, email/phone, gate restriction, time slot, entry rule (supervisor override), quantity with numbered names, note; Generate shows the QR in under a second; actions Email, Download PNG, Print / PDF (a print-styled page with the spec's caption: name, event, type, last 6 hex), Generate another (keeps the type). Clear sold-out message.
7. **Ticket list:** search by name, email or last 6 hex; status, admits used, inside; cancel, transfer, re-send; CSV import and CSV export.
8. **Live stats:** total checked in, per gate, per ticket type, inside now, scans-per-minute line (last 60 min). Refresh every 5 s or via SSE.
9. **Device panel:** each device's gate, role, label, connection state (last seen), outbox size, battery (if the phone reports it via the Battery API, else blank), last scan; add scanner (setup QR), batch hub setup codes (M5), move gate/role, revoke, "Revoke and rotate" (A4). Any device on Offline or not seen for more than 2 min is highlighted.
10. **Conflict feed:** double admissions with both scans side by side (gate, device, staff, time, offline flag), from the M5 conflicts endpoint; mark as reviewed.
11. **Overrides and audit:** attendee search with manual admit (supervisor PIN, logged as `override`); an audit view of overrides by staff.
12. **Dashboard on the hub.** During the event the dashboard runs against the hub so it works with the internet down: in hub mode serve read-only stats, device panel, conflict feed, attendee search and supervisor manual admit, with supervisor/admin login checked against the hub's synced staff hashes. Issuance, event setup and cancellation stay VM-only (show them disabled with a short note on the hub). Same UI code, picks its API by mode.
13. **Data retention job** in the worker (nightly): set `holder_name` and `holder_email` to NULL 1 year after an event ends; delete scans 3 years after; keep ticket ids, types and counts. Configurable durations; dry-run flag; logs counts.

### C. Tests

14. Unit/route tests: A1–A4; staff assignment scoping in sync; retention job (dates around the cut-off, dry run); stats aggregation; conflict review; hub-mode dashboard endpoints and refusals.
15. Playwright: admin creates an event with two gates and two ticket types, generates a ticket and opens its print page; the ticket list finds it by last 6 hex; a phone scans it and the live stats and device panel update; on the hub with the VM blocked, a supervisor logs in to the hub dashboard, sees the check-in, and does a manual admit; a forced conflict appears in the conflict feed.

## Done when

All of "Done when" for M6 in the plan holds (the dashboard works against the hub with the uplink down), A1–A4 and the retention job are done and tested, and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
