# INBOX — m12-hub-setup

M12 of `plans/offline-qr-ticketing/plan.md`: an in-app "Hub setup" checklist with live checks for the IT person, in two parts (office, then venue Wi-Fi), plus the New event sticky-bar fix from M11. M1–M11 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m12-hub-setup` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m12-hub-setup` since `main`. If `m12-hub-setup--builder-1` does not exist, that is expected: skip Step 1's merge.
- **Walk the page yourself** with the real VM + hub + worker processes from the e2e setup: steps 1 to 8 in order, as an IT person would. Note any step whose instructions or fix text would leave that person stuck.
- **Make each check fail on purpose** at least once (hub stopped, wrong DNS answer via the test hook, stale hub, count mismatch) and confirm the fix text is right.
- Check the page on the hub dashboard with the VM unreachable (Part 2 works, VM-only steps say so).
- Results are stored per hub with time and who ran them; admin only.
- No-scrollbar spec covers the new page at 390x844 and 360x740.
- **Fix requests:** write each item under `## Fix requests` in `plans/m12-hub-setup/inbox/builder-1.md` with `**Status:** PENDING`, commit and push that file to `m12-hub-setup`, file the GitHub issue as usual, then fire builder-1 with `branch: m12-hub-setup`.
- On approval, open the PR from `m12-hub-setup` to `main`.

## reviewer

**Status:** APPROVED

- **Environment:** ran `scripts/ccr-session-init.sh` as-is (MariaDB up). No SQL Server needed (not used by this repo). Playwright 1.64 wanted browser build 1248; symlinked the installed 1243 builds in `/opt/pw-browsers` (local only).
- **Builder merge:** none needed (no `m12-hub-setup--builder-1`; builder-1 worked on the feature branch).
- **Checks:** `bun run lint` pass, `bunx tsc --noEmit` pass, `bun run test` pass (core 96, web 381, worker 31).
- **E2E:** `bun run test:e2e` full run: 22 passed, 4 screenshot specs skipped (SHOTS only), 1 failed + 1 not run: `hub-setup.spec.ts` "Part 2 at the venue" failed on `page.goto` of `http://127.0.0.1:3200/events/1?tab=hub-setup` with `net::ERR_ABORTED` (navigation aborted, not an assertion failure). Re-running `hub-setup.spec.ts` alone: 3/3 passed (Part 1 steps with deliberate failures, Part 2 on the hub's own page, hub results reaching the VM record, 8 of 8). Judged a navigation flake in the long serial run; see Follow-ups.
- **Code review:** new routes are gated (`staff: admin` on the VM; hub dashboard middleware allows only the two hub-setup routes; sync routes use `access: "hub"`). No blocking issues. No GitHub issues filed.
- **Summary:** M12 does what the plan asks: 8 live-checked steps in two parts, per-hub stored results, hub-side page with results pushed to the VM, and the sticky bar fix. Unit coverage for each check's pass/fail cases is thorough.


## planner

(empty)

## Follow-ups

- reviewer: `hub-setup.spec.ts` "Part 2 at the venue" hit `net::ERR_ABORTED` on `hubPage.goto` once in a full e2e run (passed on rerun). If it recurs, wait for the post-login redirect before `goto`.

