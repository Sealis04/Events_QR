# INBOX — m11-ui-refresh

M11 of `plans/offline-qr-ticketing/plan.md`: UI refresh to the approved mockups (`plans/m11-ui-refresh/mockups/`), a phone login that lasts, a safer revoke dialog, no scrollbars on phones, and router-independent hub DNS steps. M1–M10 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m11-ui-refresh` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m11-ui-refresh` since `main`. If `m11-ui-refresh--builder-1` does not exist, that is expected: skip Step 1's merge.
- **Compare every screen with its mockup** in Playwright at 1280×800 and 390×844 (and 360×740 for phones). Builder-1 leaves screenshots in `plans/m11-ui-refresh/screenshots/`; take your own too. Layout, wording and behaviour should match; sample data in the mockups is not.
- **No scrollbars on phones** (user decision): run the builder's spec, and spot-check by hand that nothing scrolls sideways and the scanner screens need no scrolling.
- **Phone login:** log in on `/scan`, reload, close the browser context and reopen with the same storage: still logged in, also offline. After the cut-off (fake the clock) it asks again. Revoke and "Set up again" end it.
- **Revoke:** plain revoke changes no PINs; with "lost or stolen" ticked, the dialog names the affected people before confirming and they must choose a new PIN.
- Run `docker compose -f docker/compose.hub.yml config` (with and without `--profile dns`) after the DNS changes, and read section 4.6 of the setup guide as an IT person with a TP-Link router.
- No SQL Server, Prisma or EMPLOYEE/CHIEF/FOCAL roles; skip those checks.
- **Fix requests:** write each item under `## Fix requests` in `plans/m11-ui-refresh/inbox/builder-1.md` with `**Status:** PENDING`, commit and push that file to `m11-ui-refresh`, file the GitHub issue as usual, then fire builder-1 with `branch: m11-ui-refresh`.
- On approval, open the PR from `m11-ui-refresh` to `main`.

## reviewer

(empty)

## planner

(empty)

## Follow-ups

