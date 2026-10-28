# INBOX — m14-hub-setup-page

M14 of `plans/offline-qr-ticketing/plan.md`: the hub's own `/setup` page (setup code only, server address fixed by `HUB_SERVER_URL`), and a **Reset hub** action that revokes the hub on the server, wipes it and returns to `/setup`. M1–M13 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m14-hub-setup-page` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m14-hub-setup-page` since `main`. If `m14-hub-setup-page--builder-1` does not exist, that is expected: skip Step 1's merge.
- **Try to break the link endpoint:** call it on a linked hub (must refuse, nothing changes), with a wrong code many times (rate limit), with `HUB_SERVER_URL` unset (clear error, no request), and try to pass a server address in the body (ignored).
- **Redirects:** an unlinked hub sends every page (including `/login`, `/events/...`) to `/setup`; the scanner API still answers as before (`hub_not_linked`); a linked hub 404s `/setup`.
- **Reset:** blocked with unsent scans / devices / checks for a supervisor; forced by an admin only, after the warning; plain staff get nothing. After a reset: the VM shows the hub device revoked, the hub's SQLite has no tickets, staff, devices, scans, codes, keys or link, existing dashboard sessions are refused, and the worker idles without errors until the next link. With the VM unreachable and a forced reset, the page tells the admin to revoke on the server's Devices tab, and that Revoke works for hub rows.
- **Relink:** after a reset, a new code for another event links the same hub cleanly (no data from the old event shows up).
- `setup.bat` (hub dev and prod) writes `HUB_SERVER_URL` and no longer asks for the code; `hub-enroll.ts` still works and defaults to `HUB_SERVER_URL`.
- No-scrollbar spec covers `/setup` and the reset dialog at 390x844 and 360x740.
- **Fix requests:** write each item under `## Fix requests` in `plans/m14-hub-setup-page/inbox/builder-1.md` with `**Status:** PENDING`, commit and push that file to `m14-hub-setup-page`, file the GitHub issue as usual, then fire builder-1 with `branch: m14-hub-setup-page`.
- On approval, open the PR from `m14-hub-setup-page` to `main`.

## reviewer

**Status:** APPROVED
**Environment:** ready as-is after the init script, except `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` was missing; symlinked to the installed chromium-1243 (environment only, no repo change). No builder sub-branch exists (expected); reviewed the commits on `m14-hub-setup-page` since `main`.
**E2E results:** `bun run lint` pass; `bunx tsc --noEmit` pass; `bun run test` pass (web 421 tests incl. `m14-hub-setup.test.ts`, worker 31). Playwright: `hub-setup-page.spec.ts` (unlinked redirect to /setup, link, login, reset, back to /setup), `hub-setup.spec.ts`, `no-scrollbars.spec.ts` (/setup and reset dialog at 390x844 and 360x740): 12/12 pass. Link refusal on a linked hub, missing `HUB_SERVER_URL`, ignored body URL, rate limit, concurrent link, reset gating (supervisor blocked, admin-only force), revoke-self, wipe and relink are covered by the Vitest suite and I confirmed them by reading the code.
**Issues filed:** none.
**Summary:** Link, status and reset are gated as specified; the server address only comes from `HUB_SERVER_URL`, reset wipes all tables and `hub_state` (sessions die with the secret), and the loops idle quietly when unlinked. Minor note, not blocking: the per-client rate limit keys on `x-forwarded-for`, which a LAN client can spoof, but the overall 30 per 10 minutes cap still bounds guessing.

## planner

- 2026-10-28: the user also reported that linking a **dev** hub through `setup.bat` fails (no error output yet). Parked by the user; M14 drops that step anyway. If you see the cause while testing the dev path, note it under Follow-ups.

## Follow-ups

(none yet)
