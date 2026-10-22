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
**Environment:** ready as-is (init script ran; MariaDB up, chrome linked; no SQL Server/Prisma in this repo).
**E2E results:** `bun run test:e2e` 8/8 pass (hub.spec x3, offline.spec: OFFLINE banner, "Already inside (offline)", reload keeps outbox, offline staff login, outbox drains to VM; scanner.spec x4). `bun run lint`, `bunx tsc --noEmit` clean; `bun run test` all pass (web 264 incl. chaos 5,000 scans/20 phones, worker 18, core).
**Requested checks:**
1. `tickets.cancelled_at` migrations: applied M4 migrations (9c63e03) then current ones on MariaDB and SQLite: both OK, existing rows NULL. Caveat: legacy cancelled tickets stay NULL (#9).
2. IndexedDB v2 upgrade: v1 db with device+outbox opened by new IdbStore: upgrades, v1 data dropped (phone must re-enrol, as documented), new store works. v1 outbox was unused in M4.
3. Staff PIN hashes: only to authenticated, non-revoked devices (VM and hub both 401 revoked); but staff is global, so not limited to the event's staff, and not stopped after the event ends (#8).
Storage check: device/tickets/outbox/meta sealed AES-GCM in IDB; only the staff session in sessionStorage (no PIN/token).
**#5:** `/api/sync/scans` is hub-token only (route access "hub"), covered by tests.
**Issues filed:** #8 (PIN hash scope, improvement), #9 (cancelled_at backfill, improvement). Both non-blocking.
**Summary:** Solid, well-tested M5; chaos test reconciles with flags exact. Approved; PR opened to main.

## planner

(empty)
