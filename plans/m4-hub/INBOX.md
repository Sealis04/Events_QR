# INBOX — m4-hub

Milestone M4 (venue hub and sync) of `plans/offline-qr-ticketing/plan.md`. M1–M3 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m4-hub` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m4-hub` since `main`. If `m4-hub--builder-1` does not exist, that is expected: skip Step 1's merge.
- Run `scripts/ccr-session-init.sh` (MariaDB required). No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- E2E: run the VM (`bun dev`) and a hub (`APP_MODE=hub`, separate port and SQLite file) side by side. Enrol the hub to an event, generate tickets on the VM, confirm they reach the hub; enrol a phone at the hub in Playwright and scan; block the hub's access to the VM and confirm claims keep working and upload once it is back; stop the hub and confirm the phone falls back to the VM. Run the concurrency test. Confirm the hub has no signing secret anywhere.
- Real TLS/DNS (Let's Encrypt, Cloudflare, router DNS) cannot be tested here; review `docs/deploy-hub.md` for correctness instead.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m4-hub/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m4-hub`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m4-hub`.
- On approval, open the PR from `m4-hub` to `main`.

## reviewer

**Status:** APPROVED
**Environment:** ready as-is (`scripts/ccr-session-init.sh` ran clean; MariaDB, deps, .env, Chrome ok; no SQL Server needed).
**E2E results:**
- `bun run lint`, `bunx tsc --noEmit`: clean. `bun run test`: core, web 205, worker 18 pass (incl. 20 devices x 100 tickets = exactly 100 admits, multi-process version).
- `bunx playwright test`: 7/7 pass (hub 404s and no signing secret; Hub pill, admit and Cloud-only fallback; uplink cut and exactly-once upload; M3 scanner specs).
- MariaDB migration 0002 applied cleanly to a scratch DB built from 0000+0001 (M3 schema); CHECK rejects a bad `kind`. The tables were empty (my seed inserts failed on required columns), but ADD COLUMN with a default is safe on populated tables.
- SQLite hand-edited 0001 applied on a DB built from 0000 with an existing device row: row gets `kind='scanner'`, CHECK enforced.
**Issues filed:** https://github.com/Sealis04/Events_QR/issues/5 (non-blocking: `/api/sync/scans` POST accepts any device token with arbitrary device_id/result; `/sync/tickets` stays phone-readable for M5). Decision on the planner's question: not a blocker for M4 (M3-approved behaviour), but restrict before M5/production.
**Not tested here:** Docker compose build, real TLS/DNS (docs reviewed only).
**Summary:** M4 is solid and well tested: atomic SQLite claim, convergent hub/VM state, hub-first scanner with fallback. Approved.

## planner

(empty)
