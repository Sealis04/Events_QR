# INBOX — m3-scanner

Milestone M3 (online scanner) of `plans/offline-qr-ticketing/plan.md`, plus two user decisions from the M2 review. M1 and M2 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m3-scanner` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m3-scanner` since `main`. If `m3-scanner--builder-1` does not exist, that is expected: skip Step 1's merge.
- Run `scripts/ccr-session-init.sh` (MariaDB required). No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- E2E: `bun dev`; as admin create an event, a ticket type and a few tickets; as supervisor create a device setup QR; open `/scan` in Playwright, enrol, PIN login, feed ticket codes through the test hook, and check green, red already-used, exit/re-entry for a limited ticket, wrong gate, and amber for an unknown-but-valid ticket. Reload `/scan` with the network offline and confirm it loads. Cancel a ticket on a sold-out type and confirm one more can be generated.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m3-scanner/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m3-scanner`, and file the GitHub issue as usual. Builder-1 only reads its inbox file, so without this it will stop without fixing anything. Then fire builder-1 with `branch: m3-scanner`.
- On approval, open the PR from `m3-scanner` to `main`.

## reviewer

**Status:** APPROVED

**Environment:** `scripts/ccr-session-init.sh` ran as-is (bun deps, MariaDB, migrations, signing key). `mysqladmin ping` as root over TCP is denied, but the app and tests connect fine with the generated app user. Chromium at `/opt/pw-browsers/chromium-1194` worked for Playwright. No builder sub-branch exists (expected: builder-1 works directly on `m3-scanner`).

**E2E results** (`bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` on `m3-scanner` @ 045a9d2):
- lint + prettier: pass. tsc: pass.
- Vitest: core 58, web 133 (incl. 14 claim route tests: single/unlimited/limited, exit-before-reentry, cancelled, scan_id replay, parallel claims), worker 18: all pass.
- Playwright (4): enrol with setup QR, green then red "already used" on rescan; amber unknown ticket + supervisor override; scanner loads with the network off; role "both" toggle and exits: all pass.
- Decode + verify pipeline (ZXing WASM, 400 px): median 6.5 ms, max 18 ms in the sandbox. Phone timing stays a field test.
- Cancel frees a place and key retirement (409 `signing_key_retired`) covered by passing tests.

**Code review:** claim/exit use the conditional UPDATE inside a row-locked transaction and are idempotent on `scan_id`; routes are device-bearer gated; override requires a supervisor/admin `staff_id`; cancel decrement is single-flip under row lock; key file written atomically. Accepted choices from the builder (manual-search admit needs supervisor PIN, staff PIN login needs network until M5, rescanned single-entry shows "Already used") were noted as user-accepted. Non-blocking: `staff_id` is trusted from the device as in the spec; `/api/claim` ordering of SET columns relies on MariaDB left-to-right assignment (pinned by a test).

**Issues filed:** none.

**Summary:** M3 meets its plan items with solid test coverage and a clean combined run. No blocking findings.

## planner

(empty)
