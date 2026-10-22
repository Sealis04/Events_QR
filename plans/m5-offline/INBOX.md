# INBOX — m5-offline

Milestone M5 (offline mode) of `plans/offline-qr-ticketing/plan.md`, plus the fix for Sealis04/Events_QR#5 and the long-lived hub setup codes. M1–M4 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m5-offline` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m5-offline` since `main`. If `m5-offline--builder-1` does not exist, that is expected: skip Step 1's merge.
- Run `scripts/ccr-session-init.sh` (MariaDB required). No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- E2E: run the VM and a hub side by side (as in M4). In Playwright: enrol a phone, cut both hub and VM, admit offline, reload offline (outbox persists), restore and watch it drain; offline staff login. Confirm a phone token can no longer upload scans to `/api/sync/scans` on the VM (#5). Create a batch of hub setup codes and enrol a phone at the hub with the VM unreachable, then confirm the same code is rejected on the VM. Run the chaos test.
- Check that nothing sensitive (PINs, device token, event key) is stored in clear in IndexedDB/localStorage.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m5-offline/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m5-offline`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m5-offline`.
- On approval, open the PR from `m5-offline` to `main`, and close #5 if it is fixed.

## reviewer

**Status:** APPROVED
**Environment:** ready as-is (session init script ran; MariaDB up; Chrome linked; no SQL Server/Prisma in this repo).
**E2E results (all pass):** `bun run lint` ok; `bunx tsc --noEmit` ok; `bun run test` 23 web files / 264 tests + 18 worker tests pass (chaos test: 4279 scans, 627 decided offline, 279 double admissions flagged exactly); `bun run test:e2e` 8/8 pass (hub, hub-uplink-cut, offline admit + banner + reload outbox + offline staff login + drain, scanner enrol/override/exit).
**Issues filed:** none.
**Summary:** #5 is fixed (hub-only `/api/sync/scans` with event-device check; phone-scoped `/api/scans` on the VM; schema rejects unknown results). Long-lived hub codes, encrypted IndexedDB, persistent outbox, offline PIN login, conflicts and wipe are implemented and tested. Planner notes: staff PIN hashes (argon2id) are now sent to every phone and are brute-forceable offline if a phone is stolen; the offline gate-only interpretation and the v1->v2 IndexedDB reset (phones re-enrol) are noted in builder-1's summary. Not manually reviewed in depth: M6 conflict feed UI (out of scope).

## planner

(empty)
