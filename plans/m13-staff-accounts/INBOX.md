# INBOX — m13-staff-accounts

M13 of `plans/offline-qr-ticketing/plan.md`: a top-level Staff page (create, list, role, PIN reset, deactivate, reactivate) with an activity log, lockout safeguards, and clearer ticket-type form wording. M1–M12 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m13-staff-accounts` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m13-staff-accounts` since `main`. If `m13-staff-accounts--builder-1` does not exist, that is expected: skip Step 1's merge.
- **Try to break the safety rules** through the API, not only the UI: deactivate or demote yourself, deactivate or demote the last active admin (including two admins demoting each other at once), reuse a deactivated account's name in any letter case.
- **Deactivation end to end:** a logged-in dashboard session of the deactivated person gets 401 on its next request; a phone on that event loses the person at its next sync (both VM-direct and through a hub); reactivation brings them back.
- **PIN reset:** after a reset the person can do nothing but set a new PIN; the temporary PIN's hash never appears in `/api/sync` or hub payloads.
- **Activity log:** one row per change, written in the same transaction; `scripts/create-admin.ts --if-exists reset` logs with no actor and reactivates.
- Ticket-type form: new labels, summary line, early-entry box hidden until a time slot exists; existing events with saved early-entry values still load and save.
- No-scrollbar spec covers the Staff page at 390x844 and 360x740.
- **Fix requests:** write each item under `## Fix requests` in `plans/m13-staff-accounts/inbox/builder-1.md` with `**Status:** PENDING`, commit and push that file to `m13-staff-accounts`, file the GitHub issue as usual, then fire builder-1 with `branch: m13-staff-accounts`.
- On approval, open the PR from `m13-staff-accounts` to `main`.

## reviewer

**Status:** APPROVED
**Environment:** MariaDB was not installed: `apt-get update` then `apt-get install -y mariadb-server`, re-ran `scripts/ccr-session-init.sh`, granted root@127.0.0.1. Playwright: symlinked `/opt/pw-browsers/chromium-1194/chrome-linux` to the installed chromium-1243 build (config path). No SQL Server needed for this repo.
**E2E results:** `bun run lint` pass, `bunx tsc --noEmit` pass, `bun run test` pass (web 402, worker 31, core). Playwright full suite 28 passed, 6 skipped (screenshot specs): staff.spec (banner for one admin; create, PIN reset, forced change, deactivate, refused session, reactivate; Setup tab only assigns; ticket-type form wording), no-scrollbars at 390x844 and 360x740 incl. Staff page, hub specs. Unit suite m13-staff-accounts covers self/last-admin guards, concurrent mutual demotion, case-insensitive names, hashesForEvent exclusions, 401 on live session, create-admin reset logging.
**Issues filed:** none.
**Summary:** Safety rules are enforced inside one transaction with all staff rows locked; audit rows are written in the same transaction and carry no PINs or hashes. Deactivated and admin-reset accounts are excluded from hub payloads. No blocking issues.

## planner

(empty)

## Follow-ups

(none yet)
