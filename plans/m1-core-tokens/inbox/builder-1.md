# builder-1 — m1-core-tokens

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `plans/` (other than this file), `INBOX.md`. The repo is empty, so you create the whole scaffold.

## Shared files

(none)

## Tasks

Milestone M1 from `plans/offline-qr-ticketing/plan.md`. The spec is in the repo at `docs/spec.md` (do not use the artifact link). Read its sections "Ticket token format", "Data model", "Scanner app" (validation algorithm, device setup), "Venue hub and sync protocol" (the claim) and "APIs".

1. **Scaffold.** bun workspaces: `packages/core`, `apps/web`, `apps/worker` (empty placeholders with package.json for web and worker), `docker/`. TypeScript strict with project references, ESLint + Prettier, Vitest. Root scripts `lint`, `test`, and `typecheck` (`tsc --noEmit`). `.gitignore` (node_modules, .next, .env*, !.env.demo). `.env.demo` with placeholder DB settings. `docker/compose.dev.yml` running MariaDB 11.
2. **`scripts/ccr-session-init.sh`.** Idempotent: `bun install`; start MariaDB if `mariadbd` exists and isn't running; write `.env` from `.env.demo` if missing. No SQL Server, no Prisma.
3. **Token library** (`packages/core/src/token`). 34-byte payload exactly as the spec table (version, event_id u32, ticket_id 16 B, ticket_type, issued_at u32, key_id, entry_rule, gate_mask u16, slot_start u16, slot_end u16; big-endian). Ed25519 sign (libsodium-wrappers), AES-256-GCM encrypt with aad `EVT1` (WebCrypto), Base45, `EVT1:` prefix. Functions: `buildPayload`, `mintToken(payload, signingKey, eventKey, nonce?)`, `verifyToken(raw, publicKeys, eventKey)` returning a typed result or a typed error (`not_ours`, `invalid`, `wrong_event`, `unknown_key`).
4. **Setup QR codec** (`packages/core/src/setup`). `DEV1:` + Base45 of event id, one-time enrolment code, hub URL. No keys.
5. **Rule helpers** (`packages/core/src/rules`). entry_rule encode/decode (mode in top 2 bits, max admits in low 6), gate_mask from gate indexes and back, slot minute conversion, and pure functions `checkEntry(payload, ctx)` (gate and slot checks) and `decideClaim(state, scan)` / `decideExit(state, scan)` implementing the hub claim and the offline rules (inside flag, admits_used vs max, single-entry exits).
6. **Drizzle schema** (`packages/core/src/db`). Tables: events, gates, ticket_types (with `issued` counter, capacity, early-entry minutes), tickets (incl. nonce, admits_used, inside, status, issued_by, holder fields), devices, enrolment_codes, scans (append-only, client-generated id, direction, result, conflict, offline), email_queue, staff. A MariaDB schema and an SQLite schema built from shared column definitions; migrations generated for both.
7. **Zod schemas** (`packages/core/src/api`) for every server and hub endpoint in the spec's API tables (request + response).
8. **Tests.** Test vectors for: round-trip; tampered byte (ciphertext and tag); wrong event key; wrong signing key; wrong event_id; gate not allowed; before slot / after slot; unknown key_id. Assert the encoded token is 194 characters including the `EVT1:` prefix (189 Base45 chars). Unit tests for every rule helper, including the re-entry cases (single, unlimited, limited N; exit needed before re-entry). A test that migrations apply to SQLite (in memory).

## Done when

All of "Done when" for M1 in the plan holds, and `bun run lint`, `bunx tsc --noEmit` and `bun run test` pass.

## Summary for reviewer

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none) — resolved 2026-10-21 by the planner: spec exported to `docs/spec.md`.
