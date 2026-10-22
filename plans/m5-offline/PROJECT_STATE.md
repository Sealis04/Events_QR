# Project state — m5-offline

- M1 (#1), M2 (#3), M3 (#4), M4 (#6) merged.
- M4: hub mode on SQLite (`APP_MODE=hub`, no signing code), hub enrolment (`scripts/hub-enroll.ts`), sync loops in the worker (pull 30 s, push 5 s, phones 10 s), conflict convergence between hub and VM, scanner hub-first with 800 ms VM fallback and Hub / Cloud-only / Offline pill, `docker/compose.hub.yml`, `docs/deploy-hub.md`. 283 unit + 7 Playwright tests.
- Open: Sealis04/Events_QR#5 (any device token can upload scans to the VM) — fixed in this branch.
- User decision 2026-10-22: setup codes made for the hub stay valid until the event ends (single use); normal codes keep 10 minutes.
- This branch: phones decide alone when hub and VM are both unreachable; persistent encrypted local state and outbox; offline staff login; conflicts; chaos test.
