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

(empty)

## planner

(empty)
