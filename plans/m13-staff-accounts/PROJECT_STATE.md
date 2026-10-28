# Project state — m13-staff-accounts

- M1–M12 merged (#1, #3, #4, #6, #7, #10, #13, #14, #15, #16, #17, #18). M12 added the in-app hub setup checklist (`hub_checks`, migrations mysql 0007 / sqlite 0006).
- Staff accounts are global (`staff`: id, name, pin_hash, role, pin_reset). Event assignment is `event_staff` plus "issued tickets" (`apps/web/src/server/eventStaff.ts`). Phones and the hub only get PIN hashes of assigned staff with no pending PIN reset (`hashesForEvent`), and replace that list on every sync.
- Today accounts are created only by `scripts/create-admin.ts` (also run by `setup.bat`) or "Create and add" on an event's Setup tab (`POST /api/staff`). There is no list, role change, PIN reset or deactivation, and no log of admin actions.
- `route()` in `apps/web/src/server/http.ts` reloads the staff row on every request and refuses to run on a hub (`APP_MODE=hub`).
- User decisions 2026-10-28: see the M13 section of the plan. The plan file is the source of truth.
