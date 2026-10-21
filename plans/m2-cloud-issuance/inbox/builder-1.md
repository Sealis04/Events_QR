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

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
