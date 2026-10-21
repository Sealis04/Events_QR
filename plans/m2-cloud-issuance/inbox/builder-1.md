# builder-1 — m2-cloud-issuance

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M2 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M2 from `plans/offline-qr-ticketing/plan.md`: server issuance on the VM. Spec sections in `docs/spec.md`: "Event setup and QR generator", "Ticket issuance and delivery", "APIs" (cloud API), "Security" (keys, staff PIN). Reuse M1's `packages/core` (token lib, zod schemas in `src/api/cloud.ts`, Drizzle MariaDB schema in `src/db/mysql.ts`). The plan wins over the spec: no KMS, no Postmark/SES, Next.js not Fastify.

1. **Next.js app** in `apps/web` (App Router, TypeScript strict) with `APP_MODE=server` (default). All cloud API endpoints as route handlers under `/api/...`, validated with the core zod schemas. Drizzle + `mysql2` against MariaDB, using the M1 migrations.
2. **Staff auth.** Staff log in with name + PIN (argon2id). Session cookie (httpOnly, secure, SameSite=Lax). Roles staff, supervisor, admin, enforced per endpoint as in the spec's API table (any staff can generate; admin cancels/creates events; supervisor creates device setups). A CLI script `scripts/create-admin.ts` to make the first admin.
3. **Events, gates, ticket types.** `POST /api/events` (admin) creates the event and generates its AES-256 key; store the key encrypted at rest with a master key from env (`EVENT_KEY_MASTER`). Endpoints to add/edit ticket types (capacity, entry rule, gate mask, slots, early-entry 15–30 min). Gate order is append-only once tickets exist.
4. **Signing module** (`apps/web/src/server/signing.ts`, the only code that touches the Ed25519 secret key). Loads a key file encrypted with a passphrase from env (`SIGNING_KEY_PATH`, `SIGNING_KEY_PASSPHRASE`). A script `scripts/gen-signing-key.ts` creates the file. Supports `key_id` for rotation (current key + older public keys).
5. **QR generator API** `POST /api/events/{id}/tickets`: the spec's capacity transaction on MariaDB (`UPDATE ticket_types SET issued = issued + 1 WHERE … AND (capacity IS NULL OR issued < capacity)` in the same transaction as the insert, checking affected rows), idempotency key, batch quantity with numbered names, `issued_by`, internal note. Returns the token plus PNG (data URL) and SVG of each QR (`qrcode` package, level M, Base45 alphanumeric mode).
6. **Cancel, transfer, re-send.** Cancel sets status and bumps `updated_at`; transfer cancels and issues a new ticket; re-send rebuilds the byte-identical token from the stored nonce.
7. **Email.** `apps/worker` (Node/bun process, `APP_MODE=worker`) drains `email_queue` and sends via the Gmail API with a Workspace service account (domain-wide delegation; `GMAIL_SA_KEY_PATH`, `GMAIL_SENDER`). Throttle to stay under ~2,000/day (configurable), retry with backoff, store delivery status. Email body: holder name, event, ticket type, last 6 hex of ticket id, QR as inline PNG. Put the Gmail call behind an interface so tests use a mock.
8. **CSV import** `POST /api/events/{id}/tickets/import` (admin): same capacity transaction per row; report row errors.
9. **Device setup + sync endpoints** from the cloud API table: `POST /api/devices/enroll` (create a `DEV1:` setup QR with a one-time code, 10 min expiry, stored hashed; and exchange it for a device token + key bundle), `GET /api/sync/tickets?cursor=` (monotonic `(updated_at, id)` cursor, paginated), `POST /api/sync/scans` (idempotent on scan id; returns acked ids and conflicts), `GET /api/events/{id}/stats`.
10. **Minimal admin pages** only as needed to exercise the API by hand: login, event list, create event, generate tickets (form + QR shown). Full dashboard UI is M6; keep these plain.
11. **Deploy.** `docker/compose.vm.yml` (app, worker, mariadb) and `docs/deploy-vm.md`: env vars, generating keys, Nginx Proxy Manager proxy host, Cloudflare DNS, backups of the DB and key file.
12. **Tests.**
    - Automated **MariaDB** tests (the M1 reviewer flagged that MariaDB was only checked by hand): apply migrations to a real MariaDB (the session-init script / compose service) and run the integration suite against it. Skip with a clear message if no DB is reachable, but it must run in this sandbox.
    - Capacity race: 50 parallel generate calls on a type with capacity 20 create exactly 20 tickets.
    - Generated QR decodes and verifies with M1's `verifyToken`; re-send is byte-identical; cancelled tickets appear in the next sync page.
    - Idempotency key returns the same tickets on retry.
    - Auth: each endpoint rejects the wrong role.
    - Email worker against the Gmail mock, including throttling and retry.

## Done when

All of "Done when" for M2 in the plan holds; the tests above pass against MariaDB; `bun run lint`, `bunx tsc --noEmit` and `bun run test` pass; `bun dev` serves the app on :3000 with the admin pages working.

## Summary for reviewer

**Files changed:**

- `packages/core` (allowed for M2): `src/api/cloud.ts` (exported `ticketTypeInput`; added `timezone` to `createEventRequest`; new schemas `updateEventRequest`, `addTicketTypeRequest`, `updateTicketTypeRequest`, `loginRequest`, `createStaffRequest`, `transferTicketRequest/Response`, `importTicketsRequest/Response`; `createTicketsResponse` items now also carry `short_id`, `qr_png`, `qr_svg`), `src/db/mysql.ts` (new server-only table `idempotency_keys`), `drizzle/mysql/0001_conscious_goblin_queen.sql` + `meta/*` (generated by drizzle-kit), `test/db.test.ts` (reads all mysql migrations, expects `idempotency_keys`). All 58 core tests still pass; the SQLite schema is untouched.
- `apps/web`: `package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`; `src/server/*` (config, db, context, auth, http, secrets, signing, time, qr, events, tickets, devices, sync, stats, csv, staff, dbutil); `src/app/api/**/route.ts` (21 route handlers); `src/app/{layout,page}.tsx`, `login/page.tsx`, `events/[id]/page.tsx`, `_lib/client.ts` (plain admin pages); `test/*` (helpers, issuance, auth, devices-sync, csv, signing: 79 tests).
- `apps/worker`: `package.json`, `vitest.config.ts`, `src/{main,emailQueue,gmail,mime}.ts`, `test/{emailQueue,gmail}.test.ts` (17 tests).
- `scripts/`: `create-admin.ts`, `gen-signing-key.ts`, `migrate.ts`; `ccr-session-init.sh` rewritten (generates secrets for a new `.env`, never edits an existing one; creates the dev DB/user, runs migrations, creates the signing key).
- `docker/Dockerfile`, `docker/compose.vm.yml`, `.dockerignore`, `docs/deploy-vm.md`.
- Root: `package.json` (`dev`, `build` scripts), `tsconfig.json` (jsx, includes `scripts` and `apps/*/*.ts`), `eslint.config.js` and `.prettierignore` (ignore `next-env.d.ts`), `.gitignore` (`next-env.d.ts`, `.secrets`), `.env.demo` (new settings), `bun.lock`.

**What was done:**

1. Next.js 15 app in `apps/web` (`APP_MODE=server`). Every cloud-API endpoint is a route handler under `/api/...`, validated with the core zod schemas, on Drizzle + mysql2 with the M1 migrations. Handlers are plain `(Request, {params}) => Response`, wrapped by `route()` in `src/server/http.ts` (auth by role, JSON body/query validation, JSON errors), so tests call them directly.
2. Staff auth: name + PIN (argon2id via `@node-rs/argon2`), HMAC-signed session cookie (HttpOnly, SameSite=Lax, Secure by default in production / `COOKIE_SECURE`), role re-read from the DB on every request, same-origin check on cookie-authenticated writes, JSON-only bodies, in-memory login rate limit. Roles per endpoint follow the spec table (any staff generate / list / stats; admin creates events, edits types, cancels, resends, transfers, imports; supervisor creates device setups). `scripts/create-admin.ts` makes the first admin (PIN from `PIN` env or prompt).
3. Events, gates, ticket types: `POST /api/events` generates the AES-256 key and stores it AES-GCM encrypted under `EVENT_KEY_MASTER`; `GET/PATCH /api/events/{id}`, `POST /api/events/{id}/ticket-types`, `PATCH .../ticket-types/{idx}`. Gates are append-only once tickets exist (and `starts_at` is frozen then, since slot minutes are relative to it).
4. `src/server/signing.ts` is the only code that reads the Ed25519 secret. Key file is JSON with scrypt+AES-GCM-encrypted secrets and plain public keys; `scripts/gen-signing-key.ts` creates, `--rotate`s or `--retire`s generations. Events sign with their own `sign_key_id`.
5. `POST /api/events/{id}/tickets`: one transaction does idempotency-key insert, the capacity `UPDATE ... issued + n <= capacity` (rows affected checked), ticket insert and email-queue insert. Returns token + PNG data URL + SVG (qrcode, level M, forced alphanumeric mode, 4-module quiet zone, 6 px/module) + short id. Batch names are numbered when blank.
6. Cancel / transfer / re-send: `POST /api/tickets/{id}/{cancel,transfer,resend}`. Re-send rebuilds the token from the stored nonce (test: byte-identical, also via the emailed PNG).
7. `apps/worker`: drains `email_queue`, Gmail API through a service account with domain-wide delegation (hand-rolled JWT, no googleapis dependency) behind a `MailSender` interface; rolling-24h daily limit, min interval between sends, exponential backoff, permanent-error and max-attempt failure, lease recovery.
8. CSV import: `POST /api/events/{id}/tickets/import` with `{csv, idempotency_key?}`; columns `holder_name, ticket_type (index or name), holder_email?, note?`; each row runs the same transaction; row errors are reported.
9. `POST /api/devices/enroll` (setup by supervisor, or one-time-code exchange, told apart by body), `GET /api/sync/tickets` (device bearer token), `POST /api/sync/scans`, `GET /api/events/{id}/stats`.
10. Admin pages: `/login`, `/` (event list + create event for admins), `/events/{id}` (type counts + generate form with the QR shown). Checked in a real browser (Playwright) against `bun dev`.
11. `docker/compose.vm.yml` (mariadb, one-shot migrate, app, worker, `tools` profile), `docker/Dockerfile`, `docs/deploy-vm.md`.
12. Tests (all against a real MariaDB; each file creates and drops its own database from the real migrations): capacity race (50 parallel, capacity 20 gives exactly 20), QR PNG decoded with jsQR and verified with `verifyToken`, re-send byte-identical, cancelled ticket appears in next sync page, idempotency (replay, concurrent replay, key reuse, failed request not remembered), role matrix for every endpoint, email worker incl. throttling and retry against a mock sender, Gmail client against a fake fetch.

**What to check:**

- **Decisions the spec left open** (please confirm): (a) device bearer tokens are `<device_id>.<secret>`, stored as SHA-256 of the whole token; the hub authenticates as a device and sync is scoped to that device's event. (b) A phone that lost the enrol response can retry the same code with the same `device_id` within 10 min of use and gets a rotated token. (c) Transfer is net-zero on capacity (old slot handed to the new ticket); cancel alone does not free capacity. (d) `GET /sync/tickets` holds back rows younger than `SYNC_HORIZON_SECONDS` (default 2, tests use 0) so a late-committing transaction cannot land behind a cursor. (e) `sync/scans` recomputes the ticket's `admits_used/inside/status` and `scans.conflict` from all its scan rows in `scanned_at` order (earliest admit canonical, later one flagged), so replays and late batches converge; scans for unknown/foreign tickets are not acknowledged; unknown device/staff ids are stored as NULL. (f) The stats endpoint is open to any staff role. (g) Added endpoints beyond the cloud table: `POST /api/staff`, `GET /api/events`, `GET /api/events/{id}`, `GET /api/events/{id}/tickets`, transfer, ticket-type add/edit, auth login/logout/me, health.
- **Old signing secrets are kept** in the key file (so events spanning a rotation can still re-send byte-identical tickets) unless retired. The task text said "older public keys"; tickets do not store their `key_id`, so this seemed necessary. Say if you want the stricter reading.
- **Docker images were not built here**: the sandbox proxy breaks TLS inside `docker build` and Docker Hub rate-limited the `oven/bun` pull. `docker compose config` validates, and the same steps (`next build`, standalone `node server.js` with argon2 and libsodium, worker on bun) were run outside Docker.
- `.env` handling: I did not edit the existing `.env`. `ccr-session-init.sh` only fills secrets when it creates `.env` from `.env.demo`; a fresh-clone run of the script (new `.env`, DB user, migrations, signing key, create-admin) was verified in a scratch copy.
- `bun dev` passes the repo-root `.env` to Node with `--env-file-if-exists` (Next only loads `.env` from `apps/web`). Next needs the secrets in that `.env`: run `scripts/ccr-session-init.sh` on a fresh checkout.
- Not in M2 scope, left for later milestones: offline-before-cancellation flagging of scans, retention job (M6), hub-side enrol/sync (M4), CSV export, dashboard UI.
- The test helper in `apps/web/test/helpers.ts` creates databases named `<DB_NAME>_test_<random>`; the DB user needs privileges on `<DB_NAME>_test%` (the init script grants them; for compose use `TEST_DB_ADMIN_USER/PASSWORD`). If MariaDB is unreachable the suites skip with a console warning.

**Conflicts resolved:** (none)

## Fix requests

- [ ] **Sealis04/Events_QR#2 (reviewer):** `bun dev` resolves the relative `SIGNING_KEY_PATH=.secrets/signing-key.json` from `.env` against `apps/web` (Next's cwd), so `readKeyFile` throws ENOENT and every API route using the context returns 500 on a fresh checkout. Fix: resolve relative `SIGNING_KEY_PATH` and `GMAIL_SA_KEY_PATH` against the repo root (or the `.env` location) in `apps/web/src/server/config.ts`, and add a test for relative path resolution. Then verify on a fresh checkout: `bash scripts/ccr-session-init.sh`, `bun dev`, log in via `POST /api/auth/login` returns 200. Mark this done and note the fix in your summary; reference #2 in the commit message.

## Blocker

(none)
