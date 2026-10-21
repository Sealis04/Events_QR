# Offline QR Ticketing — Build Plan

Draft 2026-10-21, on hold: ticket issuance (M2) is being reconsidered. Source spec: [Offline QR Ticketing System — Technical Spec](https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7) (rev 48). Visual plan: [Build Plan](https://claude.ai/artifact/ESJVqp6ZRnBscEpacn2WWo).

The spec is the source of truth for formats, tables, endpoints and rules. This plan only sets the order, scope and done-criteria.

## Team and loop

- **Builder 1** builds every milestone, one at a time, on a branch `build/mN-<slug>` off `main`.
- **Reviewer** checks each milestone against its "Done when" and the spec. It either requests changes (wakes Builder 1 with fixes) or merges to `main`, advances `INBOX.md` to the next milestone, and wakes Builder 1.
- **Planner** writes this plan and `INBOX.md`, and fires Builder 1 for M1. It is not in the loop after that unless scope changes.

Coordination lives in `INBOX.md` on `main`. Agents wake each other through their Routines (trigger IDs are in env vars `BUILDER1_TRIGGER_ID` and `REVIEWER_TRIGGER_ID`; never print or commit them).

## Repo layout (set up in M1)

```
packages/core   token lib, setup-QR codec, entry/claim rules, schemas (zod), DB migrations
apps/cloud      Fastify + Postgres API, signing service
apps/hub        same Node service in hub mode, better-sqlite3 (WAL)
apps/web        PWA: scanner + admin dashboard
```

pnpm workspaces, TypeScript strict, Vitest, ESLint + Prettier. A `docker-compose.yml` for local Postgres.

## Milestones

### M1 — Core tokens and shared contracts (`packages/core`)
- Monorepo scaffold and CI script (`pnpm lint && pnpm typecheck && pnpm test`).
- Token lib: 34-byte payload exactly as in the spec table; Ed25519 sign (libsodium); AES-256-GCM with aad `EVT1` (WebCrypto); Base45; `EVT1:` prefix. Must run in both Node and browsers.
- `DEV1:` setup-QR codec (event id, one-time code, hub address, cert fingerprint; no keys).
- Helpers: entry_rule encode/decode, gate_mask, slot minutes; pure claim/exit decision functions shared by hub and offline scanner.
- Postgres migrations for events, ticket_types (with `issued` counter), tickets, devices, scans; matching SQLite subset.
- Zod schemas for every cloud and hub endpoint in the spec's API tables.
- **Done when:** test vectors pass for round-trip, tampered byte, wrong key, wrong event, wrong gate, out-of-slot and expired key_id; the encoded token is about 189 characters; core has no Node-only imports.

### M2 — Cloud issuance (`apps/cloud`)
- Staff auth (PIN hashed with argon2id), events, gates, ticket types.
- `POST /events/{id}/tickets`: capacity transaction from the spec, idempotency key, batch quantity, `issued_by`.
- Signing service behind a KMS interface, plus a local dev key provider. Deterministic re-send (stored nonce). Cancel and transfer bump `updated_at`.
- Email behind a provider interface (dev: log to console). CSV import.
- `/devices/enroll`, `GET /sync/tickets`, `POST /sync/scans`, `GET /events/{id}/stats`.
- **Done when:** a parallel test cannot oversell a capped type; a generated QR decodes with M1; re-send returns a byte-identical token.

### M3 — Online scanner (`apps/web`)
- PWA install, setup-QR enrolment, ready screen ("Gate A · Entry").
- Camera scan: BarcodeDetector, ZXing-WASM fallback.
- The spec's validation order and result screens (green, blue, grey, red, amber), 3 s debounce, manual search, connection pill, Entry/Exit toggle for role "both".
- Claims go to the cloud for now.
- **Done when:** frame-to-result is under 300 ms on a mid-range phone; every result state has a test.

### M4 — Venue hub and sync (`apps/hub`)
- Hub mode with better-sqlite3 in WAL; atomic `/claim` and `/exit` SQL from the spec.
- `/enroll` working offline from cached codes; self-signed TLS pinned at enrolment.
- The four sync loops, monotonic `(updated_at, id)` cursors, idempotent writes, hub time for clock sync.
- Scanner talks to the hub first.
- **Done when:** the concurrency test passes (20 simulated devices claiming the same 100 tickets gives exactly 100 admits).

### M5 — Offline mode (`apps/web`, `apps/hub`)
- IndexedDB ticket table (encrypted at rest), persistent outbox, 800 ms hub timeout with retry on every scan.
- Offline entry and exit using the shared `packages/core` rules; 60 s offline beep and orange banner.
- Hub conflict flagging: earliest `scanned_at` is canonical, later row gets `conflict = true`, dashboard alert.
- **Done when:** the chaos test (5,000 scans with random hub and access-point cuts) reconciles and every conflict is flagged.

### M6 — Dashboard (`apps/web` admin routes)
- Event workspace and QR generator UI: Email, Download PNG, Print/PDF, Generate another.
- Live check-ins (total, per gate, per type, scans per minute), device panel, conflict feed, supervisor overrides, Devices page with setup QR.
- Retention job: names and emails set to NULL 1 year after the event; scans deleted after 3 years.
- **Done when:** the dashboard works against the hub with the uplink down.

### Wrap-up — Dress rehearsal
Builder 1 writes `docs/runbook.md` (the spec's event-day runbook as a checklist) and `docs/field-test.md` (50 printed tickets, cracked screens, dim screens, paper). People run these; no code.

## Out of scope for v1
Payments and online checkout, resale, rotating QR codes, wallet passes, seat maps.

## Rules for every milestone
- Stay inside the milestone's scope; note anything else under "Follow-ups" in `INBOX.md`.
- No secrets in the repo. Dev keys are generated at runtime or come from `.env` (gitignored).
- Each milestone ends with lint, typecheck and tests green.
