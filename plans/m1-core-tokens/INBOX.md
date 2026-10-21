# INBOX — m1-core-tokens

Milestone M1 (core tokens and shared contracts) of `plans/offline-qr-ticketing/plan.md`.

## Active builders

- builder-1 — active. Works directly on `m1-core-tokens` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m1-core-tokens` since `main`. If `m1-core-tokens--builder-1` does not exist, that is expected: skip Step 1's merge.
- M1 is a library with no web app, so there is no dev server to start. E2E for this milestone = run the Vitest suites and the test vectors, plus a small script that mints a token and verifies it.
- This project has no SQL Server, Prisma, demo seeds or EMPLOYEE/CHIEF/FOCAL roles. Skip those checks; they are not BLOCKED_ENV.
- Fire builder-1 for fixes with `branch: m1-core-tokens`.
- On approval, open the PR from `m1-core-tokens` to `main`.

## reviewer

(empty)

## planner

(empty)
