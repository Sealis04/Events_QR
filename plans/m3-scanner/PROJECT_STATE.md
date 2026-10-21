# Project state — m3-scanner

- M1 merged (Sealis04/Events_QR#1): `packages/core` token lib, rules, zod schemas, Drizzle schemas.
- M2 merged (Sealis04/Events_QR#3): Next.js server on MariaDB, staff auth, events/ticket types, QR generator with capacity transaction, cancel/transfer/re-send, CSV import, Gmail API worker, device enrol + sync endpoints, VM Docker Compose. 157 tests. Docker images not yet built anywhere.
- User decisions after M2 (2026-10-21): cancelling a ticket frees its place (a cancelled reservation restarts with a new QR); old signing secrets are deleted automatically once no upcoming event uses them.
- This branch: those two changes, then the online scanner PWA talking to the VM.
