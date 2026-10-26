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

(empty)

## planner

(empty)

## Follow-ups

