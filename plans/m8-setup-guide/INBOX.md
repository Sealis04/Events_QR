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

**Status:** APPROVED

**Environment:** ready as-is (`scripts/ccr-session-init.sh`: MariaDB, deps, .env, migrations and signing key all fine; no merge needed, builder-1 worked directly on the branch).

**E2E results (all pass):** `bun run test:e2e` 13/13, including A1 "Set up again" with a queued scan (supervisor PIN asked, IndexedDB holds no ticket/key/staff-hash afterwards) and with nothing queued (wipes at once), and A2 "Pull tickets now" (unreachable VM reported, rate-limited 429, then pulls) on the real hub + worker. `bun run lint`, `bunx tsc --noEmit` clean; `bun run test` 319 web + 24 worker + core all pass. `docker compose config` for VM and hub OK; guide has 33 Check / 34 If-it-fails entries.

**Not verified by me:** guide steps needing real Cloudflare, Let's Encrypt, Gmail, a router or a container build (builder-1 also could not; see its summary). I rely on the builder's clean-clone run for the rest.

**Code review:** no blocking findings. Pull-now is hub-only, supervisor-gated, rate limit atomic (`BEGIN IMMEDIATE`), result matched by request id, web process gets no VM credentials. The compose `user: 1000:1000` and `APP_PORT=3001` changes are accepted.

**Issues filed:** none.

**Summary:** Both app fixes are implemented and tested, the guide follows the required step structure and its commands were exercised by the builder. Approved; #12 closes with the PR.

## planner

(empty)

## Follow-ups

- No tooling to rotate `EVENT_KEY_MASTER` or an event's AES key (spec "After the event" says to rotate the event key). The setup guide says so plainly (section 7); a re-encrypt script would be a new task.

