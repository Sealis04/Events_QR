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

(empty)

## planner

(empty)
