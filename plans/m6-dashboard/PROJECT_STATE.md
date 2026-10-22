# Project state — m6-dashboard

- M1 (#1), M2 (#3), M3 (#4), M4 (#6), M5 (#7) merged.
- M5: #5 fixed (only hubs upload scans to the VM); batch hub setup codes valid until event end; encrypted IndexedDB, persistent outbox, offline decisions with OFFLINE banner, offline staff PIN login with lockout, 60 s offline beep, `offline_gate_only`, conflicts endpoint `GET /api/events/{id}/conflicts`, device wipe on revoke and after the event; chaos test (5,000 scans, 20 phones) reconciles exactly.
- Open issues fixed in this branch: #8 (PIN hashes to all staff, not event-scoped), #9 (`cancelled_at` backfill).
- User decision 2026-10-22: supervisor/admin PINs of 8+ digits with slower hashing; rotate PINs after a lost phone.
- Existing admin UI is the plain M2 pages (`/`, `/login`, `/events/[id]`); M6 replaces them.
