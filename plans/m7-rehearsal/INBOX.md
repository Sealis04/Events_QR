# INBOX — m7-rehearsal

The dress-rehearsal milestone (plan: "Wrap-up — Dress rehearsal"): event-day runbook, field-test plan and a seed script for the test event. M1–M6 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m7-rehearsal` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m7-rehearsal` since `main`. If `m7-rehearsal--builder-1` does not exist, that is expected: skip Step 1's merge.
- This milestone is mostly documentation. Check it against the running app: run `scripts/ccr-session-init.sh` and `bun dev`, run `scripts/rehearsal-seed.ts` against the dev database, open the printed sheet, and walk the runbook's T−24 h and Doors steps in the dashboard and `/scan` (Playwright is fine). Every button, screen and command the docs name must exist with that name.
- Read the docs as a non-developer would: short steps, plain words, nothing assumed.
- No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m7-rehearsal/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m7-rehearsal`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m7-rehearsal`.
- On approval, open the PR from `m7-rehearsal` to `main`.

## reviewer

**Status:** NEEDS_FIXES (docs only; builder-1 re-fired)
**Environment:** ready as-is. `scripts/ccr-session-init.sh` ran clean (MariaDB, migrations, signing key). No SQL Server/Prisma here. Created an admin and a staff user, ran `rehearsal-seed.ts --yes`, started `bun dev`.
**E2E (Playwright, real dashboard + /scan):**
- PASS: lint, tsc, `bun run test` (core 60, web 308, worker 24).
- PASS: seed produced 50 tickets (dashboard `50 of 50`, per-type 22/8/6/6/6 issued); sheet written.
- PASS: dashboard tabs QR generator, Tickets, Live stats, Devices, Conflicts, Attendees & overrides, Setup exist with the runbook's names. Add a scanner, Show setup QR, Batch codes for the venue hub, How many, Make hub setup codes, Move, Revoke, Revoke and rotate, Staff on this event, Ticket types, Gates, Save event, the offline-phones box, Find an attendee, Confirm admit, Overrides by staff, Mark reviewed, Export CSV, Cancel, Transfer, Checked in, Inside now all present. "Revoke and rotate" confirm dialog appears.
- PASS: /scan: Set up for event, Type the code instead, Use code, Staff login, Log in, ready header `Gate A · ...`, pill `Cloud-only · 0 queued` (no hub in sandbox), Entry/Exit buttons, Manual search, Admit (supervisor PIN), Set up again, Sign out. Manual admit worked: Checked in 1, override listed.
- FAIL: #11 (DEV1 text not obtainable), #12 (Set up again does not wipe).
- NOT RUN: camera scanning of the sheet QRs (no camera), hub mode pages (`pending_scans`, hub dashboard read-only tabs), install app button.
**Issues filed:** #11, #12.
**Summary:** Docs are clear and match the app almost everywhere. Two inaccuracies need fixing, one of which could leave attendee data on phones.

## planner

(empty)

## Follow-ups

(none)
