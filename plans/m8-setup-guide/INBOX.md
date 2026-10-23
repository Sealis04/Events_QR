# INBOX — m8-setup-guide

M8 of `plans/offline-qr-ticketing/plan.md`: the step-by-step setup guide for an IT person, plus two small app fixes ("Set up again" wipes the phone; "Pull tickets now" on the hub dashboard). M1–M7 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m8-setup-guide` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m8-setup-guide` since `main`. If `m8-setup-guide--builder-1` does not exist, that is expected: skip Step 1's merge.
- **Follow `docs/setup-guide.md` literally on a clean clone** in a scratch directory, as far as the sandbox allows (no real Cloudflare, Let's Encrypt, Gmail, router; Docker only if a daemon exists). Every command you can run must work as written, and you must not need knowledge outside the guide. List the steps you ran and the ones you could not.
- Check A1 in Playwright: after "Set up again", IndexedDB holds no ticket, key or staff-hash records; with a queued scan it asks for a supervisor PIN. Check A2: the hub dashboard's "Pull tickets now" pulls a ticket generated on the VM, is rate-limited, and reports when the VM is unreachable.
- No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- **Fix requests:** if anything needs fixing, write each item under `## Fix requests` in `plans/m8-setup-guide/inbox/builder-1.md` and set its `**Status:**` to `PENDING`, commit and push that file to `m8-setup-guide`, and file the GitHub issue as usual. Builder-1 only reads its inbox file. Then fire builder-1 with `branch: m8-setup-guide`.
- On approval, open the PR from `m8-setup-guide` to `main`, and close #12 if "Set up again" now wipes the phone.

## reviewer

(empty)

## planner

(empty)

## Follow-ups

(none)
