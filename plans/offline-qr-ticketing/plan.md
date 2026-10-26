# Offline QR Ticketing — Build Plan

Approved 2026-10-21. Source spec: `docs/spec.md`, exported from [the Claude Docs spec](https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7) (rev 48). Visual plan: [Build Plan](https://claude.ai/artifact/ESJVqp6ZRnBscEpacn2WWo).

The spec is the source of truth for token format, entry rules, claim logic and sync. **Where this plan and the spec differ, this plan wins.** The differences are all in "Deployment and stack": the spec's cloud services are replaced by a self-hosted VM.

## Deployment and stack

No cloud services. Everything is self-hosted.

| Part | Choice |
|---|---|
| Server ("cloud" in the spec) | Your VM, behind Nginx Proxy Manager with an open port forward; DNS on Cloudflare |
| App | **Next.js** (App Router, TypeScript): admin dashboard, QR generator, scanner PWA and all APIs as route handlers, in one app |
| Server database | **MariaDB** on the VM |
| Venue hub | The same Next.js build run with `APP_MODE=hub` on a mini PC or Pi 5, using **SQLite** (better-sqlite3, WAL) |
| ORM / migrations | Drizzle, with one schema for MariaDB and SQLite |
| Background work | A small Node worker from the same repo (`APP_MODE=worker`) for the email queue, sync loops and the retention job |
| Signing key | Ed25519 key file on the VM, encrypted at rest with a passphrase from env, loaded only by the signing module. Never on the hub or phones |
| Event AES keys | Generated per event on the VM, stored encrypted in MariaDB, and delivered to enrolled devices |
| Email | Gmail API through the Workspace service account (domain-wide delegation, sending as one mailbox). Queued and throttled to stay under about 2,000 messages a day |
| Crypto | libsodium (Ed25519) + WebCrypto AES-256-GCM, shared by server, hub and browser |
| QR decoding | BarcodeDetector where available, with ZXing-WASM fallback |
| Packaging | Docker Compose: `app` + `worker` + `mariadb` on the VM; `app` (hub mode) on the hub |

### Hub HTTPS and DNS
- Cloudflare record `hub.<domain>` points to the hub's LAN IP, set to DNS only (not proxied).
- The hub gets a Let's Encrypt cert through the Cloudflare DNS-01 challenge (Nginx Proxy Manager on the hub, or certbot-dns-cloudflare) and renews it while it has internet.
- The venue router (or dnsmasq on the hub) answers `hub.<domain>` locally, so phones still find the hub with the internet down.
- This replaces the spec's self-signed cert pinning, which browsers can't do.

### Data flow
- **Before the event:** staff generate tickets on the VM; the worker emails them; the hub and phones download the ticket list and keys.
- **During:** phones talk to the hub over venue Wi-Fi. The hub syncs with the VM whenever internet is up. If the hub is unreachable, phones validate alone.
- **After:** the hub uploads all scans to the VM, which flags double admits.

## Team and loop

Follows the Agent Team Protocol in `CLAUDE.md`, using the existing Builder 1 and Reviewer Routines.

- Each milestone gets a feature branch `mN-<slug>` from `main`, with its tasks in `plans/<branch>/inbox/builder-1.md`.
- **Builder 1** builds the milestone on that branch, then fires the Reviewer.
- **Reviewer** either fires Builder 1 with fix requests, or approves and opens a PR to `main`.
- **Planner** then sets up the next milestone's branch and fires Builder 1.

## Repo layout (set up in M1)

```
packages/core   token lib, setup-QR codec, entry/claim rules, zod schemas, Drizzle schema
apps/web        Next.js app: server mode, hub mode, admin + scanner routes
apps/worker     email queue, sync loops, retention job
docker/         compose files for the VM and the hub
```

bun workspaces, TypeScript strict, Vitest, ESLint + Prettier. `docker compose up` runs MariaDB locally for development.

## Milestones

### M1 — Core tokens and shared contracts (`packages/core`)
- Monorepo scaffold and a check script (`bun run lint`, `bunx tsc --noEmit`, `bun run test`).
- Token lib: the spec's 34-byte payload; Ed25519 sign; AES-256-GCM with aad `EVT1`; Base45; `EVT1:` prefix. Runs in Node and browsers.
- `DEV1:` setup-QR codec (event id, one-time code, hub URL; no keys).
- Helpers: entry_rule encode/decode, gate_mask, slot minutes; pure claim/exit decision functions shared by the hub and the offline scanner.
- Drizzle schema for events, ticket_types (with `issued` counter), tickets, devices, scans, enrolment codes, email queue; migrations for MariaDB and SQLite.
- Zod schemas for every server and hub endpoint in the spec's API tables.
- **Done when:** test vectors pass for round-trip, tampered byte, wrong key, wrong event, wrong gate, out-of-slot and expired key_id; the encoded token is about 189 characters; core has no Node-only imports; migrations apply to both MariaDB and SQLite.

### M2 — Server issuance on the VM (`apps/web` server mode, `apps/worker`)
- Staff auth (PIN hashed with argon2id), events, gates, ticket types.
- `POST /api/events/{id}/tickets`: the spec's capacity transaction on MariaDB (`UPDATE … WHERE issued < capacity`, check rows affected), idempotency key, batch quantity, `issued_by`.
- Signing module that loads the encrypted key file. Deterministic re-send (stored nonce). Cancel and transfer bump `updated_at`.
- Email queue + Gmail API sender (service account credentials JSON from env path, never committed); throttle and retry. CSV import.
- `/api/devices/enroll`, `GET /api/sync/tickets`, `POST /api/sync/scans`, `GET /api/events/{id}/stats`.
- Docker Compose for the VM; a short `docs/deploy-vm.md` covering Nginx Proxy Manager and Cloudflare.
- **Done when:** a parallel test cannot oversell a capped type; a generated QR decodes with M1; re-send returns a byte-identical token; a test email sends through a Gmail API mock.

### M3 — Online scanner (`apps/web` scanner routes)
- PWA manifest + service worker caching the scanner routes; setup-QR enrolment; ready screen ("Gate A · Entry").
- Camera scan: BarcodeDetector, ZXing-WASM fallback.
- The spec's validation order and result screens (green, blue, grey, red, amber), 3 s debounce, manual search, connection pill, Entry/Exit toggle for role "both".
- `navigator.storage.persist()` requested at enrolment.
- Claims go to the VM for now.
- **Done when:** frame-to-result is under 300 ms on a mid-range phone; the scanner reloads and opens with the network off; every result state has a test.

### M4 — Venue hub and sync (`apps/web` hub mode, `apps/worker`)
- Hub mode on SQLite; the atomic `/claim` and `/exit` SQL from the spec.
- `/enroll` working offline from cached codes.
- The four sync loops (hub to VM pull/push in the worker; phone to hub), monotonic `(updated_at, id)` cursors, idempotent writes, hub time for clock sync.
- Scanner talks to the hub first.
- Hub Docker Compose and `docs/deploy-hub.md`: DNS-only Cloudflare record, DNS-01 cert, local DNS override on the venue router.
- **Done when:** the concurrency test passes (20 simulated devices claiming the same 100 tickets gives exactly 100 admits); the hub keeps admitting with its uplink cut.

### M5 — Offline mode (`apps/web`, hub)
- IndexedDB ticket table (encrypted at rest), persistent outbox, 800 ms hub timeout with retry on every scan.
- Offline entry and exit with the shared `packages/core` rules; 60 s offline beep and orange banner.
- Hub conflict flagging: earliest `scanned_at` is canonical, the later row gets `conflict = true`, dashboard alert.
- **Done when:** the chaos test (5,000 scans with random hub and access-point cuts) reconciles and every conflict is flagged.

### M6 — Dashboard (`apps/web` admin routes)
- Event workspace and QR generator UI: Email, Download PNG, Print/PDF, Generate another.
- Live check-ins (total, per gate, per type, scans per minute), device panel, conflict feed, supervisor overrides, Devices page with setup QR.
- Works against the VM before and after the event, and against the hub during it.
- Retention job: names and emails set to NULL 1 year after the event; scans deleted after 3 years.
- **Done when:** the dashboard works against the hub with the uplink down.

### Wrap-up — Dress rehearsal
Builder 1 writes `docs/runbook.md` (the spec's event-day runbook as a checklist, updated for the VM and hub) and `docs/field-test.md` (50 printed tickets, cracked screens, dim screens, paper). People run these; no code.

## Decisions after M2 (2026-10-21)

- Cancelling a ticket frees its place (`ticket_types.issued` goes down by 1). A cancelled reservation starts over with a new QR through the normal generator. Transfer stays net-zero.
- Old signing secrets are kept only while an upcoming event uses that key generation, then deleted automatically; public keys stay.
- After M3 (accepted 2026-10-22): manual-search admits need a supervisor PIN; staff PIN login on the phone needs the network until M5 adds offline login; a rescanned single-entry ticket shows "Already used".
- After M4 (2026-10-22): setup codes made for the hub stay valid until the event ends (single use) so phones can be set up offline at the hub; normal on-screen codes keep the 10-minute expiry. Only hubs may upload scans to the VM (#5).
- After M5 (2026-10-22): supervisor and admin PINs need 8+ digits and use slower hashing, because phones hold PIN hashes for offline login; phones get hashes only for the event's assigned staff (#8); after a lost phone, revoke it and rotate the affected PINs.
- After M7 (2026-10-23): "Set up again" on a phone must wipe it (uploading queued scans first); the hub dashboard gets a "Pull tickets now" button. Both go into M8.
- From M3 on, the reviewer writes fix requests into `plans/<branch>/inbox/builder-1.md` as well as GitHub issues.

### M8 — Step-by-step setup guide (added 2026-10-22)
One guide, `docs/setup-guide.md`, for an IT person doing the first install from zero. It replaces nothing: it links the deeper `docs/deploy-vm.md` and `docs/deploy-hub.md` where useful, but can be followed on its own top to bottom.
- Prerequisites checklist: VM specs and OS, domain on Cloudflare, Gmail Workspace admin access, hub hardware (Pi 5 / mini PC, SSD, UPS, router, access points), phones.
- VM: install Docker, clone the repo, fill `.env` (every variable explained, which are secrets), generate the signing key and event-key master, `docker compose up`, run migrations, create the first admin (8+ digit PIN), backups.
- Nginx Proxy Manager: proxy host for the app, SSL, port forward; Cloudflare DNS record for the app.
- Gmail: create the service account, domain-wide delegation scope, key file, sender mailbox, send a test email.
- Hub: OS install, Docker, `docker/compose.hub.yml`, Cloudflare DNS-only `hub.<domain>` record, DNS-01 certificate and renewal, router or dnsmasq local DNS override, `scripts/hub-enroll.ts`, standby hub.
- First event end to end: create event, gates, ticket types, staff assignment; generate a test ticket; print hub setup codes; set up a phone; scan it; check the dashboard; pull the internet cable and scan again.
- Every step ends with a "Check" (a command or what you should see) and a "If it fails" line.
- Troubleshooting table: common errors (certificate not trusted on phones, `hub.<domain>` not resolving offline, Gmail 403 / delegation, migrations, phone stuck on Cloud-only, clock drift) with fixes.
- Upgrading to a new version and rotating keys.
- **Done when:** the reviewer follows the guide in a clean sandbox as far as it can (everything except real Cloudflare, Let's Encrypt, Gmail and router steps) without needing any knowledge outside the guide, and every command in it runs.

### M9 — Test copy on the VM (added 2026-10-26, built by the planner on the user's request)
A separate copy of the system beside production, at `test.<domain>`, for trying new versions, training and rehearsals.
- `docker/compose.test.yml`: Docker project `events-qr-test`, own MariaDB volume (`events_qr_test`), own `.env.test` and `.secrets-test`, app on 3002, Mailpit (`axllent/mailpit:v1.31.1`) as the mail catcher on loopback 8025.
- `INSTANCE_LABEL` setting: red "TEST COPY" banner on every dashboard page and on the scanner (via `/api/health`, remembered for offline), `[TEST]` in email subjects.
- `MAIL_TRANSPORT=smtp` (with `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`): the worker sends over plain SMTP to Mailpit instead of the Gmail API.
- `scripts/test-reset.ts`: empties the test database, re-migrates, creates Test Admin / Test Supervisor / Test Staff and seeds the 50-ticket rehearsal with its sheet. Refuses unless `--yes`, `INSTANCE_LABEL` set, `DB_NAME` contains "test" and `PUBLIC_URL` is not `PRODUCTION_URL`.
- `docs/test-setup.md`: one-time setup, everyday use, upgrading the test copy first, switching the standby hub between test and production.

### M10 — Test copy on a Windows PC through a Cloudflare Tunnel (added 2026-10-26, built by the planner)
- Optional `tunnel` service (`--profile tunnel`) in `docker/compose.test.yml`: `cloudflare/cloudflared:2026.10.0`, token from `CLOUDFLARE_TUNNEL_TOKEN` in `.env.test`, public hostname pointed at `http://app:3000`.
- `docs/test-setup.md` section 5: WSL2 + Docker Desktop, clone inside Ubuntu, tunnel creation in Zero Trust, Mailpit at `localhost:8025` on the PC, keeping the PC awake, optional Cloudflare Access, tunnel troubleshooting. No venue-hub testing this way.

## Out of scope for v1
Payments and online checkout, resale, rotating QR codes, wallet passes, seat maps.

## Rules for every milestone
- Stay inside the milestone's scope; note anything else under "Follow-ups" in `INBOX.md`.
- No secrets in the repo: signing key file, key passphrase, Gmail service-account JSON, Cloudflare token and DB passwords come from env or mounted files (gitignored).
- Each milestone ends with lint, typecheck and tests green.
