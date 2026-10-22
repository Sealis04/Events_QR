# INBOX — m7-rehearsal

The dress-rehearsal milestone (plan: "Wrap-up — Dress rehearsal"): event-day runbook, field-test plan and a seed script for the test event. M1–M6 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m7-rehearsal` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m7-rehearsal` since `main`. If `m7-rehearsal--builder-1` does not exist, that is expected: skip Step 1's merge.
- This milestone is mostly documentation. Check it against the running app: run `scripts/ccr-session-init.sh` and `bun dev`, run `scripts/rehearsal-seed.ts` against the dev database, open the printed sheet, and walk the runbook's T−24 h and Doors steps in the dashboard and `/scan` (Playwright is fine). Every button, screen and command the docs name must exist with that name.
- Read the docs as a non-developer would: short steps, plain words, nothing assumed.
- No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m7-rehearsal/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m7-rehearsal`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m7-rehearsal`.
- On approval, open the PR from `m7-rehearsal` to `main`.

## reviewer

(empty)

## planner

(empty)

## Follow-ups

(none)
