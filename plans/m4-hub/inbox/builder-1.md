# builder-1 — m4-hub

**Status:** DONE
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M4 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M4 from `plans/offline-qr-ticketing/plan.md`: the venue hub and sync. Spec sections in `docs/spec.md`: "Venue hub and sync protocol" (hardware, the claim SQL, sync loops, conflict handling), "Scanner app" (device setup via the hub), "APIs" (hub API), "Admin dashboard and event-day operations" (runbook, failure modes). Plan sections: M4 and "Hub HTTPS and DNS". The plan wins over the spec.

Background you need: the hub is a mini PC / Pi on the venue Wi-Fi. During the event it is the only authority for "used". It holds **no signing secret** (public keys and the event AES key only), so it can verify and claim tickets but never mint them. The VM keeps issuing tickets; the hub syncs with it whenever internet exists. Phones talk to the hub first; in M4 they fall back to the VM when the hub is unreachable (offline-alone mode is M5).

1. **Hub mode.** The same Next.js build with `APP_MODE=hub`, using SQLite (better-sqlite3, WAL, `busy_timeout`) through the M1 SQLite schema and migrations. In hub mode, issuance/admin routes that need the signing key or MariaDB are disabled (404/403); scanner-facing routes are served: `POST /api/enroll`, `POST /api/claim`, `POST /api/exit`, `GET /api/sync`, `POST /api/scans`, `GET /api/health`, plus staff PIN login for phones. Keep request/response shapes identical to the VM's so the scanner client is unchanged.
2. **Atomic claim/exit on SQLite.** The spec's `BEGIN IMMEDIATE` claim and exit SQL. Note SQLite assigns SET columns simultaneously (unlike MariaDB), so the spec's `admits_used + 1 >= max_admits` form is the correct one here. Idempotent on `scan_id`. Reuse `decideClaim`/`decideExit` for responses.
3. **Hub enrolment with the VM.** A way to bind a hub to one event: an admin/supervisor creates a hub setup code on the VM (new endpoint or a `role: hub` on the existing enrol flow) and `scripts/hub-enroll.ts <VM URL> <code>` stores the hub's credential, the event key bundle and public keys in the hub DB/secret file. The hub never receives the Ed25519 secret.
4. **Sync loops** (in `apps/worker` with `APP_MODE=hub`, or a hub process; your call, document it):
   - Ticket pull, VM to hub, every 30 s and on demand: `GET /api/sync/tickets` with the monotonic cursor; also ticket types, staff (name, role, PIN hash, for phone login at the hub), device setting changes, revocations.
   - Scan push, hub to VM, every 5 s when online, batches up to 500, idempotent; mark acked scans.
   - Enrolment codes: the hub keeps unused phone enrolment codes (hashed) pulled from the VM so phones can enrol with no internet. Phones enrolled at the hub must also become valid devices on the VM (push them up on the next sync) so the VM fallback accepts their token.
   - Device pull, hub to phone, every 10 s (`GET /api/sync` on the hub): ticket changes incl. `admits_used`/`inside` and newly used ids, device settings, hub time for clock sync.
   - Cursors are `(updated_at, id)` pairs; every write idempotent on its id; any loop safe to retry. Exponential backoff when the VM is unreachable; the hub keeps serving claims throughout.
5. **Conflicts.** Scans that reach the hub (or the VM) for a ticket already admitted elsewhere keep both rows; the later one by `scanned_at` gets `conflict = true`. Make the hub and VM agree after sync (the VM's M2 recompute already does this for uploaded scans; make sure hub-side state converges too).
6. **Scanner talks to the hub first.** The phone uses the hub URL from its `DEV1:` setup QR; if the hub does not answer within 800 ms it uses the VM for that scan and the pill shows Cloud-only; Hub (green) when the hub answers. Retry the hub on every scan. Enrolment tries the hub first, then the VM.
7. **Deploy.** `docker/compose.hub.yml` (app in hub mode + sync process, SQLite on a volume) and `docs/deploy-hub.md`: hardware (Pi 5 / mini PC with SSD, UPS, dedicated router + AP per gate), Cloudflare DNS-only record `hub.<domain>` to the hub's LAN IP, Let's Encrypt cert via Cloudflare DNS-01 (Nginx Proxy Manager on the hub or certbot-dns-cloudflare) with renewal, a local DNS override on the venue router or dnsmasq on the hub so `hub.<domain>` resolves with no internet, standby hub procedure, and that the hub needs internet at least every ~60 days for cert renewal. Never commit the Cloudflare token.
8. **Tests.**
   - Concurrency: 20 simulated devices claiming the same 100 tickets at once against the hub's SQLite gives exactly 100 admits (and every other attempt rejected).
   - Uplink cut: with the VM unreachable, the hub keeps admitting and exiting; when it comes back, all scans upload exactly once and the VM's counts match the hub's.
   - A ticket generated on the VM appears on the hub within one pull cycle and on a phone within one device-pull cycle; a cancellation does too and is then rejected at the gate.
   - Phone enrolment at the hub with no VM reachable, then that phone's token works against the VM after the next sync.
   - Exit / re-entry rules on the hub match the VM's (shared test table run against both backends).
   - Hub mode refuses issuance routes and never has a signing secret on disk.
   - Playwright: scanner enrolled at the hub shows the Hub pill and admits; stop the hub and the next scan goes to the VM with the Cloud-only pill.

## Done when

All of "Done when" for M4 in the plan holds (concurrency test passes; the hub keeps admitting with its uplink cut), and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

**Files changed:**

- `packages/core`: `src/db/{shared,mysql,sqlite}.ts` (`kind` column on `devices` and `enrolment_codes`; hub-only SQLite tables `hub_state`, `hub_scan_outbox`, `hub_device_outbox`), `src/api/{common,hub,cloud}.ts` (key bundle `cloud_url`, health `pending_scans`, new schemas for hub setup, `/sync/meta`, `/sync/scans` GET, `/sync/devices`), migrations `drizzle/mysql/0002_curly_prism.sql` and `drizzle/sqlite/0001_bored_sandman.sql` (+ snapshots and journals), `test/db.test.ts`.
- `apps/web/src/hub/*` (new): `db.ts`, `context.ts`, `state.ts`, `http.ts`, `claim.ts`, `recompute.ts`, `enroll.ts`, `sync.ts`, `scans.ts`, `routes.ts`, `vmclient.ts`, `vmsync.ts`, `link.ts`, `loops.ts`.
- `apps/web/src/server`: new `mode.ts`, `errors.ts` (HttpError/json moved out of `http.ts`, re-exported), `constants.ts`; edited `http.ts` (hub-mode 404 guard, `hub` access, `requestOrigin`), `auth.ts` (`kind` on devices), `claim.ts` (a hub token cannot scan), `devices.ts` (hub setup, enrol by kind, `cloud_url`), `events.ts` (`cloud_url` in key bundle), `sync.ts` (`syncMeta`, `syncVmScans`, `syncDevices`; recompute order now `(scanned_at, id)`), `config.ts` (hub and `PUBLIC_URL` settings).
- `apps/web/src/app/api`: new `hubs/setup`, `hubs/enroll`, `sync/meta`, `sync/devices`, `enroll`, `scans`; edited `claim`, `exit`, `sync`, `health`, `auth/login`, `devices/enroll`, `sync/scans` (hub/VM dispatch with `byMode`; GET on `sync/scans`). New `src/middleware.ts` (CORS on the scanner API; 404 for everything else on a hub).
- Scanner: new `src/scanner/routes.ts` (hub-first `RoutedClient`, 800 ms), edited `sync.ts` (`syncFromBest`, per-server cursors, enrol hub then VM), `staff.ts` (`loginStaffRouted`), `types.ts`, `src/app/scan/ScannerApp.tsx` (Hub / Cloud-only / Offline pill, immediate first sync).
- Worker and scripts: `apps/worker/src/hubMain.ts` (new), `apps/worker/src/main.ts`, `scripts/hub-enroll.ts`, `scripts/hub-migrate.ts`.
- Deploy: `docker/compose.hub.yml`, `docker/Dockerfile` (`/data` owned by uid 1000), `docs/deploy-hub.md`, `docs/deploy-vm.md` (HUB_URL, PUBLIC_URL, section 9), `.env.demo`, `apps/web/package.json` (better-sqlite3, `./hub/*` export), `apps/web/next.config.ts`, `bun.lock`.
- Tests: `apps/web/test/{hub-helpers,entry-rules-parity,hub-claim,hub-sync,hub-loops,hub-mode,hub-vm-endpoints,scanner-routed}.test.ts` + `test/fixtures/claim-worker.ts`; e2e `apps/web/e2e/{hub.spec,prepare-hub,proxy}.ts`, `playwright.config.ts` (second server, VM horizon 1), `e2e/scanner.spec.ts` (waits out the horizon).

**What was done:**

1. Hub mode: `APP_MODE=hub` serves `/api/{enroll,devices/enroll,claim,exit,sync,scans,health,auth/login}` plus the scanner PWA from SQLite (better-sqlite3 under Node, `bun:sqlite` under Bun because Bun cannot load better-sqlite3; same file, WAL, busy_timeout, synchronous FULL). Everything else is 404 (middleware, plus a guard in `route()`). The hub has no signing code path: no `src/hub` file imports the signer, MariaDB or the VM context (a test enforces it).
2. Atomic claim/exit in `BEGIN IMMEDIATE` with the spec's SQL, idempotent on `scan_id`, `decideClaim`/`decideExit` reused. A shared scenario table runs against the VM and the hub (`entry-rules-parity.test.ts`).
3. Hub enrolment: supervisor `POST /api/hubs/setup` makes a one-time code, `scripts/hub-enroll.ts <VM URL> <code>` exchanges it (`POST /api/hubs/enroll`) for a hub device token (`devices.kind = 'hub'`) and the key bundle (event key and public keys only), then runs a first sync.
4. Sync loops live in the worker (`APP_MODE=hub`, `src/hub/loops.ts`): pull every 30 s (meta, tickets, VM scans; also on demand when a claim names an unknown ticket), push every 5 s (devices enrolled at the hub, then scans, batches of 500), exponential backoff, phones poll `GET /api/sync` every 10 s. Cursors are `(updated_at, id)` for tickets and `(received_at, id)` for scans; the hub stamps pulled rows with its own clock so phones never miss them, and a phone keeps one cursor per server.
5. Conflicts: both rows are kept; hub and VM rebuild a ticket's state and `conflict` flags from the scans in `(scanned_at, id)` order. The hub also pulls the VM's scans, so both sides converge (tested with an admit at each).
6. Scanner: hub first with an 800 ms limit and the VM as fallback, same `scan_id` on both attempts; Hub (green) / Cloud-only (blue) / Offline (orange) pill; enrolment and staff login try the hub first. A 401 only wipes the phone when it comes from the server the phone enrolled at.
7. Deploy: `docker/compose.hub.yml` (migrate, app, worker, tools; optional `proxy` and `dns` profiles) and `docs/deploy-hub.md` (hardware, Cloudflare DNS-only record, DNS-01 certificate with NPM or certbot, renewal every ~60 days, router/dnsmasq override, standby, after the event).
8. Tests: the 20 devices x 100 tickets concurrency test (exactly 100 admits of 2000 attempts) plus a multi-process version on one SQLite file; uplink cut and catch-up; VM ticket to hub to phone; cancellation; phone enrolment at the hub with no VM then use at the VM; hub-mode refusals; loops/backoff; routed client; two real servers plus worker and switchable proxies in Playwright (Hub pill and admit, hub hangs so the phone falls back to the VM with Cloud-only, uplink cut and exactly-once upload).

Results: `bun run lint`, `bunx tsc --noEmit` clean; `bun run test`: core 60, web 205, worker 18 passed; `bunx playwright test` (what `bun run test:e2e` runs): 7 passed.

**What to check:**

- Schema changes were needed on both dialects (`devices.kind`, `enrolment_codes.kind`; hub-only tables). The SQLite migration `0001` is hand-edited to `ALTER TABLE ... ADD COLUMN`, because drizzle-kit's table rebuild selected the new column from the old table and failed. Its snapshot is the generated one. Please confirm the MariaDB `0002` applies on an existing database.
- The VM's recompute order changed from `(scanned_at, received_at, id)` to `(scanned_at, id)` so hub and VM agree (`received_at` differs between them). Same-second ticks of one ticket's entry/exit are therefore ordered by random scan id; real gates are seconds apart.
- `docker/compose.hub.yml` and the Dockerfile `/data` change could not be built here (no Docker daemon): I checked `docker compose config`, and ran the Next standalone build with `APP_MODE=hub` (better-sqlite3 is traced and loads). Real TLS, Let's Encrypt, Cloudflare and router DNS are untested; review `docs/deploy-hub.md` instead.
- Middleware reads `process.env.APP_MODE` at request time; the Playwright hub spec proves the 404s and CORS on `next start`.
- Phones talk to the hub cross-origin when the page comes from the VM, hence CORS `*` on the scanner API (bearer tokens, no cookies). `/api/auth/login` is in that set.
- `/api/sync/tickets` and `POST /api/sync/scans` still accept any device token (existing tests rely on it); the new hub endpoints (`meta`, `GET scans`, `devices`) require a hub token.
- A hub enrolled phone not yet pushed to the VM is treated as "not known there yet" (offline), not as a revocation.
- Known limits, written in the docs: enrolment codes expire after 10 minutes, so offline enrolment needs codes made shortly before the uplink dropped; one event per hub; the staff list is mirrored without deletions.

**Conflicts resolved:** (none)

## Fix requests

(none)

## Blocker

(none)
