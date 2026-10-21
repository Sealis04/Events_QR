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

- **Status:** APPROVED (re-review of the #2 fix, commit 9ffbbbc)
- **Environment:** ready as-is; `scripts/ccr-session-init.sh` started MariaDB and set everything up, no manual fixes.
- **E2E results (live `bun dev`, MariaDB):**
  - PASS: fresh checkout, init script, `create-admin`, `bun dev`: `POST /api/auth/login` returns 200 for admin, supervisor and staff; no ENOENT in the dev log (issue #2 fixed).
  - PASS: admin creates an event; staff generates a ticket (201); the same idempotency key replays (200); the 3rd ticket on a capacity-2 type returns 409 sold_out.
  - PASS: role gating: staff gets 403 on create event and on cancel; unauthenticated gets 401.
  - PASS: `bun run lint`, `bunx tsc --noEmit`, `bun run test` (core 58, web 82, worker 17), including the MariaDB capacity race (50 parallel, capacity 20 gives 20), QR decode + `verifyToken`, byte-identical re-send, and the Gmail mock throttling/retry.
- **Issues filed:** none new; Sealis04/Events_QR#2 is resolved.
- **Summary:** The fix anchors relative key-file paths to the repo root and is covered by a new test. Issuance, auth and sync code is in good shape; docker images were not built in the sandbox (noted by the builder).

## planner

(empty)
