# builder-1 — m6-dashboard

**Status:** DONE
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

**Files changed:**
- `packages/core`: `src/db/mysql.ts`, `src/db/sqlite.ts` (staff.pin_reset, event_staff, devices battery/outbox/reported_at, scans reviewed_at/by, tickets.holder_phone), `src/api/cloud.ts` (new schemas: change-pin, heartbeat, device panel, event staff, review, manual admit, overrides; richer conflicts item; `for: "scanner"` on login; `holder_phone`), migrations `drizzle/mysql/0004_m6_staff_scope`, `0005_backfill_cancelled_at` (hand-written: #9 backfill + flags existing supervisors/admins `weak`), `0006_holder_phone`; `drizzle/sqlite/0003_m6_staff_scope` (hand-edited: ADD COLUMN before the staff rebuild), `0004_backfill_cancelled_at`, `0005_holder_phone`; `test/db.test.ts`.
- `apps/web/src/server`: `auth.ts` (PIN rules, hash cost, session encode/decode shared with hub), `pins.ts` (new: settleLogin, changePin), `staff.ts`, `http.ts`, `errors.ts` (assertSameOrigin moved here), `eventStaff.ts` (new), `deviceAdmin.ts` (new), `dashboard.ts` (new: manual admit, overrides, review), `claim.ts` (dashboard option, pin_reset check), `sync.ts`, `stats.ts`, `tickets.ts` (search email/phone/status, total, ticketDetail, holder_phone), `csv.ts` (export, phone column), `events.ts`, `config.ts` (retention settings).
- `apps/web/src/hub`: `dashboard.ts` (new: hub dashboard handlers), `session.ts` (new), `http.ts` (staff access), `routes.ts`, `state.ts`, `sync.ts`, `claim.ts`, `vmsync.ts` (disable hashes of staff no longer listed).
- `apps/web/src/middleware.ts` (hub serves the dashboard paths), `scanner/{client,cycle,staff}.ts`, `app/scan/ScannerApp.tsx` (heartbeat with battery, `for: "scanner"`).
- New/changed API routes under `apps/web/src/app/api`: `auth/{login,logout,me,change-pin}`, `devices/{[id],[id]/revoke,heartbeat}`, `events/route`, `events/[id]/{route,stats,conflicts,devices,tickets,tickets/export,admit,overrides,staff,staff/[staffId]}`, `scans/[id]/review`, `tickets/[id]`.
- UI (all new except login): `app/layout.tsx`, `app/dashboard.css`, `app/_lib/{client,types,useSession}`, `app/_components/{Shell,TypeFields}`, `app/(dash)/{layout,page}`, `(dash)/login`, `(dash)/events/new`, `(dash)/events/[id]/{page,print/page,_tabs/*}` (pages moved into the `(dash)` route group so the dashboard CSS does not touch `/scan`).
- Worker: `src/retention.ts` (new), `src/main.ts`; `.env.demo`; `scripts/create-admin.ts`; docs `deploy-vm.md`, `deploy-hub.md`.
- Tests: new `test/m6-security.test.ts`, `test/dashboard.test.ts`, `apps/worker/test/retention.test.ts`, `e2e/dashboard.spec.ts`; updated `test/{helpers,hub-helpers,auth,hub-sync,hub-mode,scanner-enrol}.test.ts`, `e2e/{constants,prepare,hub.spec}`, `playwright.config.ts`.

**What was done:**
- A1: supervisor/admin PINs need 8+ digits (create via API/UI/script and change via `POST /api/auth/change-pin`); staff keep 6 characters. Every hash now uses argon2id m=64 MiB, t=3, p=1 (about 0.3 s in hash-wasm here); weaker hashes are upgraded at login. Existing supervisors/admins are flagged `pin_reset=weak` by migration; at login the flag clears silently if the typed PIN already has 8+ digits, otherwise the session can only call me/logout/change-pin (403 `pin_change_required` everywhere else, also for overrides and setup). A flagged person's hash is withheld from phones/hub. Phone login sends `for: "scanner"` and gets 403 instead of a restricted session.
- A2 (#8): `event_staff` table; effective staff = issuers + explicit adds − explicit removals; `GET/PUT /api/events/{id}/staff[/{staffId}]` (admin) and the Setup tab. `/api/sync` and `/api/sync/meta` send only those hashes, none after `ends_at`. The hub disables hashes it is no longer sent (empty `pin_hash`, row kept because scans reference it).
- A3 (#9): migration backfills `cancelled_at = updated_at` (MariaDB and SQLite), idempotent.
- A4: `POST /api/devices/{id}/revoke {rotate}` and "Revoke and rotate" button; rotate flags every staff member ever tied to the event (we do not record what a phone downloaded) with `pin_reset=rotate`.
- B5–B11: event list and creation, workspace tabs (QR generator, Tickets, Live stats, Devices, Conflicts, Attendees and overrides, Setup), print page, CSV import/export, device panel with Move / Revoke / Revoke and rotate / setup QR / batch hub codes, conflict feed with review, manual admit with PIN re-entry, override audit. Phones send a heartbeat (outbox size, battery where the Battery API exists) after each successful sync.
- B12: hub serves the same UI and URLs (`byMode`): login for supervisors/admins against its synced hashes (its own session secret kept in `hub_state`), me/logout, event, stats, devices, conflicts, attendee search (name / last 6 hex; emails are not mirrored to the hub), overrides, manual admit (recorded with the hub's device id so the VM accepts the upload). Issuance, setup, cancel, review show disabled with a note.
- B13: nightly retention in the worker (`RETENTION_PII_DAYS`=365, `RETENTION_SCANS_DAYS`=1095, `RETENTION_DRY_RUN`, `RETENTION_HOUR_UTC`).
- Added `holder_phone` (generator field the inbox asked for; cleared by retention with name/email).
- Tests: lint, `tsc`, `bun run test` (core 60, web 300, worker 24) and `bun run test:e2e` (10) pass.

**What to check:**
- The migration `mysql/0005` second statement flags *all* existing supervisors and admins `weak` (that is what withholds their short-PIN hashes from phones immediately); they clear on their next login if their PIN already has 8+ digits.
- `sqlite/0003` is hand-edited (drizzle-kit's rebuild of `staff` copied a column that did not exist yet).
- Rotate flags everyone tied to the event, including the supervisor who presses the button (their session becomes change-PIN-only straight away). I chose this because the server does not record which hashes a phone held.
- The cancelled_at backfill does not bump `updated_at`, so hubs/phones that already synced those tickets will not see it (only matters for events straddling the upgrade).
- Device panel on the VM shows `last_seen`/outbox/battery only from phones that talked to the VM directly; on the hub it is the hub's view. Hub heartbeat data is not forwarded to the VM.
- Hub conflict "reviewed" is VM-only (not synced to the hub).
- The `(dash)` route group move changes file paths for `/`, `/login`, `/events/*`; URLs are unchanged.
- `Resend` stays admin-only (API table); non-admins see a hint to type the email before Generate.

**Conflicts resolved:** (none)

## Fix requests

(none)

## Blocker

(none)
