# INBOX — m6-dashboard

Milestone M6 (admin dashboard) of `plans/offline-qr-ticketing/plan.md`, plus longer supervisor/admin PINs and the fixes for Sealis04/Events_QR#8 and #9. M1–M5 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m6-dashboard` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m6-dashboard` since `main`. If `m6-dashboard--builder-1` does not exist, that is expected: skip Step 1's merge.
- Run `scripts/ccr-session-init.sh` (MariaDB required). No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; the roles here are staff, supervisor, admin.
- E2E: walk the dashboard as admin (event setup, generator with print page, ticket list search, CSV import/export, device panel, conflict feed), as supervisor and as staff (check role gating). Run a VM and a hub side by side, block the hub's uplink, and use the hub dashboard (stats, device panel, manual admit). Check that a 6-digit supervisor PIN is refused, that a phone only receives hashes of the event's assigned staff (#8), and the retention job's dry run.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m6-dashboard/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m6-dashboard`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m6-dashboard`.
- On approval, open the PR from `m6-dashboard` to `main`, and close #8 and #9 if they are fixed.

## reviewer

**Status:** APPROVED
**Environment:** ready as-is (`scripts/ccr-session-init.sh` ran clean: deps, migrations, signing key; MariaDB up; Chrome linked). `mysqladmin ping` without credentials is refused, which is expected for the app user setup.
**E2E results:** `bun run lint` pass; `bunx tsc --noEmit` pass; `bun run test` pass (core 60, web 300, worker 24); `bun run test:e2e` 10/10 pass, including the dashboard spec (create event, generate, print page, last-6-hex search, live stats/devices) and the hub spec with the VM blocked (supervisor login on the hub, check-in visible, manual admit). Route tests cover role gating (staff gets 403 on devices, conflicts, review, export, overrides, admit), 6-digit supervisor PIN refusal, flagged-PIN lockout, #8 staff-scoped sync (removal and event end), #9 backfill idempotence, Revoke and rotate, and the retention dry run and cut-off dates. Every API route declares its access level.
**Issues filed:** none.
**Summary:** Complete and well covered; all of A1-A4, B5-B13 are implemented and the full suite is green. Builder's notes (all existing supervisors/admins flagged weak by migration, rotate flags the pressing supervisor too, hub-side conflict review VM-only) are acceptable known behaviours. Opening the PR to main; it closes #8 and #9.

## planner

(empty)
