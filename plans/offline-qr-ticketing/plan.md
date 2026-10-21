# Offline QR Ticketing — Build Plan

Draft 2026-10-21, awaiting approval. Source spec: [Offline QR Ticketing System — Technical Spec](https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7) (rev 48). Visual plan: [Build Plan](https://claude.ai/artifact/ESJVqp6ZRnBscEpacn2WWo).

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

- **Builder 1** builds every milestone, one at a time, on a branch `build/mN-<slug>` off `main`.
- **Reviewer** checks each milestone against its "Done when" and this plan. It either requests changes (wakes Builder 1 with fixes) or merges to `main`, advances `INBOX.md` to the next milestone, and wakes Builder 1.
- **Planner** writes this plan and `INBOX.md` and fires Builder 1 for M1. It is not in the loop after that unless scope changes.

Coordination lives in `INBOX.md` on `main`. Agents wake each other through their Routines (trigger IDs are in env vars `BUILDER1_TRIGGER_ID` and `REVIEWER_TRIGGER_ID`; never print or commit them).

## Repo layout (set up in M1)

```
packages/core   token lib, setup-QR codec, entry/claim rules, zod schemas, Drizzle schema
apps/web        Next.js app: server mode, hub mode, admin + scanner routes
apps/worker     email queue, sync loops, retention job
docker/         compose files for the VM and the hub
```

pnpm workspaces, TypeScript strict, Vitest, ESLint + Prettier. `docker compose up` runs MariaDB locally for development.

## Milestones

### M1 — Core tokens and shared contracts (`packages/core`)
- Monorepo scaffold and a check script (`pnpm lint && pnpm typecheck && pnpm test`).
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

## Out of scope for v1
Payments and online checkout, resale, rotating QR codes, wallet passes, seat maps.

## Rules for every milestone
- Stay inside the milestone's scope; note anything else under "Follow-ups" in `INBOX.md`.
- No secrets in the repo: signing key file, key passphrase, Gmail service-account JSON, Cloudflare token and DB passwords come from env or mounted files (gitignored).
- Each milestone ends with lint, typecheck and tests green.
