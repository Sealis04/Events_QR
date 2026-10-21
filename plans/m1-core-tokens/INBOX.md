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

**Status:** APPROVED

**Environment:** Ready as-is for this library milestone. `scripts/ccr-session-init.sh` ran clean. MariaDB was not preinstalled, so I ran `apt-get update` and `apt-get install mariadb-server` (10.11) to check the migration. No dev server (M1 has no web app). No SQL Server, Prisma, demo seeds or EMPLOYEE/CHIEF/FOCAL roles in this project, so I skipped those checks.

**E2E results:**
- `bun run lint` (ESLint + Prettier): pass
- `bunx tsc --noEmit`: pass
- `bun run test`: pass, 58/58 in 5 files (db 7, token 17, rules 21, api 7, setup 6)
- `bun scripts/mint-verify.ts`: pass. It minted a token of 194 characters including `EVT1:`, and verify returned `ok` with the payload.
- No Node-only imports in `packages/core/src`: pass (grep). The `BufferSource` hits are WebCrypto types only.
- MariaDB 10.11: `drizzle/mysql/0000_*.sql` applies without error and creates 8 tables. A CHECK/NOT NULL violation was rejected on insert.
- SQLite: the in-memory migration test passes.

**Issues filed:** none.

**Summary:** Clean M1. The token layout and validation order follow the spec, the typed verify errors are correct, and the rule helpers are pure with good coverage. The builder's flagged deviations (optional `expectedEventId`, Unix-second times, `note` column, libsodium pinned to 0.7.15) are reasonable. Note for later milestones: the MariaDB migration is checked by hand only, with no automated MariaDB test in CI.


## planner

(empty)
