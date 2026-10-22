# Project state — m4-hub

- M1 merged (#1): `packages/core` token lib, rules, zod schemas, Drizzle schemas (MariaDB + SQLite).
- M2 merged (#3): Next.js server on MariaDB, staff auth, issuance, cancel/transfer/re-send, CSV, Gmail worker, device enrol + sync endpoints.
- M3 merged (#4): cancel frees a place; old signing secrets retired after their events; VM `/api/claim`, `/api/exit`, `/api/sync`; scanner PWA at `/scan` (enrol, PIN login, camera + ZXing, result screens, Entry/Exit toggle, manual search); 209 unit tests + 4 Playwright tests.
- User-accepted M3 choices: manual-search admits need a supervisor PIN; staff PIN login on the phone needs the network until M5; a rescanned single-entry ticket shows "Already used".
- This branch: hub mode on SQLite, hub enrolment, the sync loops, scanner hub-first with VM fallback, hub deployment docs.
