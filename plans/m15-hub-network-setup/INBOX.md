# INBOX — m15-hub-network-setup

M15 of `plans/offline-qr-ticketing/plan.md`: `setup.bat` walks a hub through its network setup (name, LAN IP, DNS service, firewall, "Do this now" box) and won't finish without them; the web app setup requires `HUB_URL` when a hub is used; the app warns about `HUB_URL` problems and plain-http logins; the phone's setup error says what it could not reach. M1–M14 are merged on `main`.

## Active builders

- builder-1 — active. Works directly on `m15-hub-network-setup` (no `--builder-1` sub-branch unless it hit the conflict fallback, and no PR from it).
- builder-2 — not used.
- builder-3 — not used.

## Notes for the reviewer

- Review the commits on `m15-hub-network-setup` since `main`. If `m15-hub-network-setup--builder-1` does not exist, that is expected: skip Step 1's merge.
- `setup.bat` cannot run in this sandbox. Review it by reading: every path through hub dev, hub prod (new env and Keep), and web app dev/prod with and without a hub. Check that it cannot reach `:done` for a hub without `HUB_DOMAIN`, `HUB_LAN_IP` and `HUB_DNS_BIND`; that the IP list excludes WSL/Hyper-V/Docker/loopback adapters; that the DNS service is recreated when the name or IP changed; that the elevated firewall step is optional and its failure does not stop the setup; that the "Do this now" box is shown on every hub run and written to the text file; and that nothing secret is written to that file. If `setup.sh` exists, it is out of scope.
- If any logic was moved to a PowerShell helper script, run it with `pwsh` if available, or at least parse it.
- **App warnings:** event with a linked hub and `HUB_URL` unset, `http://localhost:...`, or an IP-only/`http://` value → warning on Devices and Hub setup tabs; correct `https://<name>` → no warning. Login over plain http with a Secure cookie (simulate: production cookie on a non-localhost http origin) → the https message, not the supervisors message. Phone setup with an unreachable hub and cloud → an error naming both addresses, and the phone stays on setup with that message (no silent loop); the used code is not retried.
- No-scrollbar spec covers any new UI at 390x844 and 360x740.
- **Fix requests:** write each item under `## Fix requests` in `plans/m15-hub-network-setup/inbox/builder-1.md` with `**Status:** PENDING`, commit and push that file to `m15-hub-network-setup`, file the GitHub issue as usual, then fire builder-1 with `branch: m15-hub-network-setup`.
- On approval, open the PR from `m15-hub-network-setup` to `main`.

## reviewer

**Status:** APPROVED
**Environment:** `ccr-session-init.sh` ran, but its final `mysqladmin ping -uroot` over TCP was refused; MariaDB was up and the unix socket worked, so nothing was needed. The e2e config hardcodes `/opt/pw-browsers/chromium-1194`; this sandbox has 1243, so I symlinked 1194 to it (outside the repo). No SQL Server needed for this repo.
**E2E results:** `bun run lint` pass; `bunx tsc --noEmit` pass; `bun run test` pass (web 440, worker 31 + core); `bun run test:e2e` 35 passed, 6 skipped (screenshot specs). That includes m15-hub-warnings (warning banner on Devices and Hub setup tabs, gone after revoking the hub, login https message) and no-scrollbars at 390x844 and 360x740. The first e2e run failed everywhere because of the missing browser path; it passed after the symlink.
**setup.bat / PowerShell:** not run (no Windows or pwsh here). Reviewed by reading: hub dev and prod always go through `:hub_network` (name, IP, DNS bind) before the stack is built; DNS is recreated every run; Stop paths go to `:fail`; the firewall step only warns; the box is written to `HUB_NEXT_STEPS.txt` (gitignored) with no secrets; the web app paths use `:ensure_hub_url` for new and Keep'd files.
**Issues filed:** https://github.com/Sealis04/Events_QR/issues/29 (improvement, non-blocking): the elevated firewall script is written to the user-writable `%TEMP%`; also notes the `nslookup` `Name:` parsing on localized Windows.
**Summary:** M15 matches the task list. Automated checks are green and the app warnings behave as specified. The batch and PowerShell parts could only be read, so run `setup.bat` once on a real Windows PC before relying on it.

## planner

(empty)

## Follow-ups

- From M14 review: the hub link rate limit keys on `x-forwarded-for`, which a LAN client can spoof (global cap still applies). Not in M15 scope.
