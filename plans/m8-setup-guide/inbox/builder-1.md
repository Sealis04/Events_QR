# builder-1 — m8-setup-guide

**Status:** DONE
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`docs/setup-guide.md` (new), small corrections to `docs/deploy-vm.md`, `docs/deploy-hub.md`, `docs/runbook.md` and `.env.demo` where the guide exposes a gap, plus the two app changes in part A (scanner "Set up again", hub "Pull tickets now") and their tests. Do not change other app code; list anything else under Follow-ups in `plans/m8-setup-guide/INBOX.md`.

## Shared files

(none)

## Tasks

M8 from `plans/offline-qr-ticketing/plan.md` (read its M8 section: it is the spec for the guide), plus two small app fixes the user asked for. Describe the app as built on `main`; where the plan, spec and app differ, the app wins for the guide's wording.

### A. App fixes (do these first)

1. **"Set up again" wipes the phone (user decision 2026-10-23, follow-up to Sealis04/Events_QR#12).** In `/scan`, "Set up again" first tries to upload the outbox (hub, then VM). If anything is still queued, show how many scans would be lost and require a supervisor PIN to continue. Then wipe the device token, event keys, ticket table, staff hashes, outbox and session, and show the setup screen. Tests (unit with the in-memory/fake-IndexedDB store, plus a Playwright check that no ticket or key record remains in IndexedDB afterwards). Update the runbook's wipe step to mention it next to Revoke. Reference #12 in the commit.
2. **"Pull tickets now" on the hub dashboard (user decision 2026-10-23).** A supervisor/admin button on the hub dashboard that triggers an immediate VM → hub pull (tickets, staff, settings) and shows the result (pulled N changes, or "VM not reachable" with the last successful pull time). Rate-limit to once per 10 s. Implement it so the app process signals the sync worker (e.g. a flag row in `hub_state` the worker polls every second, or a local endpoint on the worker) without giving the web process VM credentials it does not already have. Tests for the trigger, the rate limit and the unreachable case. Replace the runbook's `docker compose ... restart worker` "forced pull" step with this button (keep the restart as a fallback line).

### B. Setup guide (M8)

3. **`docs/setup-guide.md`** for an IT person doing the first install from zero, following the plan's M8 bullets in order: prerequisites checklist; VM (Docker, clone, every `.env` variable explained with which are secrets, key generation, `docker compose -f docker/compose.vm.yml up -d`, migrations, first admin with an 8+ digit PIN, backups of DB and key file); Nginx Proxy Manager proxy host + SSL + port forward + Cloudflare record; Gmail service account with domain-wide delegation, scope, key file, sender, test email; hub (OS, Docker, `docker/compose.hub.yml`, DNS-only `hub.<domain>`, DNS-01 certificate and renewal, router/dnsmasq override, `scripts/hub-enroll.ts`, standby hub); first event end to end (event, gates, ticket types, staff assignment, test ticket, print hub setup codes, set up a phone, scan, dashboard, then pull the internet cable and scan again); upgrading to a new version (pull, migrations, rebuild, order of VM then hub, phone re-setup when the store format changes) and rotating keys (`scripts/gen-signing-key.ts --rotate`, event key master).
   - Every step ends with **Check:** (exact command or what you should see) and **If it fails:** (one line).
   - A troubleshooting table at the end: phones don't trust the hub certificate; `hub.<domain>` doesn't resolve offline; Cloudflare proxy (orange cloud) left on for the hub record; Gmail 403 / delegation not set; Gmail daily limit; migrations fail; phone stuck on Cloud-only; clock drift between phone, hub and VM; worker can't write the key file; 6-digit supervisor PIN refused.
   - Link to `docs/deploy-vm.md`, `docs/deploy-hub.md`, `docs/runbook.md` and `docs/field-test.md` for depth; the guide must still be followable on its own.
4. **Verify the guide in this sandbox** as far as possible: run every command that does not need real Cloudflare, Let's Encrypt, Gmail, a router or Docker Hub, on a clean checkout (`git clone` into a scratch dir, follow the guide literally). Record in your summary which steps you ran, which you could not and why. Try `docker compose -f docker/compose.vm.yml config` and, if a Docker daemon is available, `docker compose build`; if not, say so. Fix the guide (or `.env.demo`/deploy docs) wherever following it literally fails.

## Done when

The plan's M8 "Done when" holds, A1 and A2 are implemented and tested, and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

**Files changed:**
- A1: `apps/web/src/scanner/reset.ts` (new), `apps/web/src/app/scan/ScannerApp.tsx`, `apps/web/test/scanner-reset.test.ts` (new), `apps/web/test/scanner-idb.test.ts`, `apps/web/e2e/scanner.spec.ts`.
- A2: `apps/web/src/hub/pullnow.ts` (new), `hub/loops.ts`, `hub/routes.ts`, `hub/state.ts`, `hub/vmsync.ts`, `apps/web/src/app/api/hub/pull/route.ts` (new), `apps/web/src/app/_components/PullNow.tsx` (new), `apps/web/src/app/(dash)/events/[id]/page.tsx`, `apps/web/src/middleware.ts`, `apps/web/test/hub-pullnow.test.ts` (new), `test/hub-loops.test.ts`, `test/hub-mode.test.ts`, `apps/web/e2e/hub.spec.ts`.
- Docs/config: `docs/setup-guide.md` (new), `docs/runbook.md`, `docs/deploy-hub.md`, `docs/deploy-vm.md`, `.env.demo`, `docker/compose.vm.yml` (see "What to check", item 1), `plans/m8-setup-guide/INBOX.md` (Follow-ups only).

**What was done:**
- A1 (#12): "Set up again" (login screen and scanner screen) calls `setUpAgain`: drains the outbox hub-then-VM; with scans still queued it shows "N scans not uploaded" and needs a supervisor name + PIN (server, else the phone's own staff hashes offline; staff accounts are refused), then `store.wipe()` (device token, event keys, tickets, staff hashes, outbox, lockout counter) and the setup screen. Unit tests (memory store with fake fetch, IDB store check of every object store) and two Playwright tests (queued scan, supervisor needed, IndexedDB empty afterwards; nothing queued wipes at once). Runbook and hub doc wipe steps updated.
- A2: `POST /api/hub/pull` (hub only, supervisor/admin, same-origin checked) writes a request row in `hub_state` after a 10 s rate limit (atomic, `BEGIN IMMEDIATE`); the worker's new one-second watcher runs one `pullCycle` (serialised with the scheduled pull) and writes `pull_result`; the request waits up to 20 s for it. The web process gets no VM credentials. Answers: `Pulled N changes`, `VM not reachable` + last successful pull (new `last_pull_at` key), 429 with `retry_after`, or "worker did not answer". Button on the hub dashboard's event page. Unit tests (trigger, rate limit, unreachable, no worker, roles, real loops) and a Playwright test on the real hub + worker. Runbook now uses the button, restart kept as fallback.
- Guide: `docs/setup-guide.md` with prerequisites, VM, NPM/SSL/Cloudflare/port forward, Gmail, hub (incl. DNS-01, DNS override, enrol, standby), first event end to end, upgrading, key rotation, troubleshooting table; every step has Check and If it fails.

**What to check:**
1. **Guide verification found two real deployment bugs, fixed minimally** (please confirm you accept them, they are outside the listed owned files): (a) `docker/compose.vm.yml`: `worker` and `tools` now run as `1000:1000` (and `HOME=/tmp`), because the app runs as `node` (uid 1000) and the key files (mode 0600) created by `tools` as root made `/secrets` unreadable for the app (confirmed with a uid-1000 container), and the worker's rename of `signing-key.json` would have re-created a root-owned file. The guide has `sudo chown 1000:1000 .secrets`. (b) NPM with `--network host` takes port 3000 itself (its backend), which collides with the app's `127.0.0.1:3000`: confirmed (NPM crash-loops with EADDRINUSE while the app holds 3000, and takes 0.0.0.0:3000 as soon as it is free). The guide uses `APP_PORT=3001` and forwards NPM to 3001; `.env.demo` and `deploy-vm.md` mention it.
2. **What I ran literally on a clean clone** (scratch dir, `git clone` of this branch): step 1.3 (`.env` fill, compose config OK), 1.8 (backup script against the real `mariadb:11` container: dump OK; no `crontab` binary in this sandbox, guide now says to `apt install cron`), 1.5/1.6/1.7 (equivalent bun commands on the host instead of containers: migrations, key generation, `next build` + `next start`, health JSON, create-admin, login 200, 7-digit admin PIN refused), 4.2 (event creation via API, `/api/hubs/setup` curl, real code), 4.3 (hub migrate, hub app, `hub-enroll`, hub worker; health before/after as in the guide), `Pull tickets now` against the real hub + worker processes (answer, then 429), 2.1 (the NPM `docker run` with the real image: found the port clash and an IPv6-less-kernel note, now in the guide; `:81` answers 200 with `DISABLE_IPV6=true`), `docker compose config` for VM and hub incl. `proxy`/`dns` profiles, and `docker pull` of every image (mariadb:11, jc21/nginx-proxy-manager:2.12.3, 4km3/dnsmasq:2.90-r3, node, oven/bun).
3. **What I could not run:** `docker compose build` / the container versions of 1.5-1.7: a Docker daemon works and Docker Hub pulls work, but builds cannot reach the npm registry through the sandbox proxy (`SELF_SIGNED_CERT_IN_CHAIN` in `bun install`); the workaround needs proxy credentials in the build, which I did not do. So the compose `user:` change is checked by `config` and by reasoning/a uid-1000 read test, not by a built image. Also not run: real Cloudflare, Let's Encrypt/NPM certificate, router/dnsmasq override, Gmail (3.x), the browser UI steps of section 5 (labels checked against the source; the flows are covered by the e2e tests), real phones, the unplugged-cable test (covered by `hub.spec.ts`), and the NPM proxy-host forms.
4. Tricky: the guide's step 5.7 needs the supervisor's account mirrored to the hub first (about 30 s after assigning staff on the VM); I saw a `wrong name or PIN` at the hub until the first pull. `Pull tickets now` itself does not make staff appear sooner than one pass, it is one pass.
5. `bun run lint`, `bunx tsc --noEmit`, `bun run test` (all 3 workspaces) pass; `bun run test:e2e`: the full `bun run test:e2e` run: 13 passed.

**Conflicts resolved:** (none)

## Fix requests

(none)

## Blocker

(none)
