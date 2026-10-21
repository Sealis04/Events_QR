# INBOX — m2-cloud-issuance

Milestone M2 (server issuance on the VM) of `plans/offline-qr-ticketing/plan.md`. M1 (`packages/core`) is merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m2-cloud-issuance` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m2-cloud-issuance` since `main`. If `m2-cloud-issuance--builder-1` does not exist, that is expected: skip Step 1's merge.
- Run `scripts/ccr-session-init.sh`; MariaDB is required this time (install `mariadb-server` if missing). No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- E2E: `bun dev`, create an admin with `scripts/create-admin.ts`, log in, create an event and ticket type, generate tickets, and verify a generated token with `scripts/mint-verify.ts` or core's `verifyToken`. Check role gating for staff / supervisor / admin.
- Gmail is mocked in tests; do not send real email.
- Fire builder-1 for fixes with `branch: m2-cloud-issuance`.
- On approval, open the PR from `m2-cloud-issuance` to `main`.

## reviewer

(empty)

## planner

(empty)
