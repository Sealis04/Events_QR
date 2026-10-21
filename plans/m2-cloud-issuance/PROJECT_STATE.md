# Project state — m2-cloud-issuance

- M1 merged 2026-10-21 (Sealis04/Events_QR#1): monorepo scaffold, `packages/core` (token lib, setup-QR codec, rules, zod API schemas, Drizzle schemas for MariaDB and SQLite with migrations), 58 tests.
- M1 notes: `verifyToken` takes an optional `expectedEventId`; DB times are Unix seconds; `libsodium-wrappers` pinned to 0.7.15; MariaDB migration was only checked by hand (M2 adds automated MariaDB tests).
- This branch: M2, the server on the self-hosted VM (Next.js + MariaDB), ticket generation, email via Gmail API, device enrolment and sync endpoints.
