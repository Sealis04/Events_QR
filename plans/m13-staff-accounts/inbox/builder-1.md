# builder-1 — m13-staff-accounts

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`packages/core/src/db/` (staff columns, `audit_log`), new migrations under `packages/core/drizzle/mysql/` (and `drizzle/sqlite/` only if needed, see A2), zod schemas under `packages/core/src/api/`, `apps/web/src/server/{staff,auth,pins,eventStaff}.ts` and a new `server/audit.ts`, `apps/web/src/app/api/staff/**`, a new `apps/web/src/app/(dash)/staff/` page and its nav link, `apps/web/src/app/(dash)/events/[id]/_tabs/Setup.tsx`, `apps/web/src/app/_components/{TypeFields,EventForm}.tsx`, `apps/web/src/app/_lib/types.ts`, `scripts/create-admin.ts`, tests in `apps/web/test/` and `apps/web/e2e/`, `docs/setup-guide.md`. List anything else under Follow-ups in `plans/m13-staff-accounts/INBOX.md`.

## Shared files

(none)

## Tasks

M13 of `plans/offline-qr-ticketing/plan.md` (read the M13 section). Use the M11 look (`dashboard.css` tokens, Dialog, Menu, tags), in-page confirmation dialogs, and keep the no-scrollbar rule on phones. The Staff page is VM-only (routes built with `route()` already 404 on a hub).

### A. Schema and core (first, one commit)

1. MariaDB `staff.deactivated_at` (Unix seconds, null = active), with a migration and test.
2. New `pin_reset` value `admin` (temporary PIN set by an admin); extend `ck_staff_pin_reset` and the `PinReset` types (`server/pins.ts`, `server/auth.ts`, `eventStaff.ts`, `_lib/types.ts`). The hub never receives staff with a pending reset or deactivated staff (`hashesForEvent`), so change the SQLite schema only if you find a path where it would; say which in your summary.
3. MariaDB `audit_log`: `id` (autoincrement), `at` (Unix seconds), `actor_staff_id` (nullable; null = server command), `action` (varchar), `target_kind` (varchar, `staff` for now), `target_id` (varchar), `detail` (JSON: e.g. old/new role, name). Index on (`target_kind`, `target_id`, `at`) and on `at`. Actions this milestone: `staff.created`, `staff.role_changed`, `staff.pin_reset`, `staff.deactivated`, `staff.reactivated`, `staff.recovered`. Never put PINs or hashes in `detail`.
4. zod request/response schemas for the staff API in `packages/core/src/api/`.

### B. Server rules and API

5. `GET /api/staff` (admin): every account with role, status (active / must change PIN / deactivated), events assigned (count or names), created and last change from the log.
6. `PATCH /api/staff/[id]` (admin) with one of: `{ role }`, `{ reset_pin: "<temporary>" }` (sets the hash and `pin_reset = 'admin'`; PIN rules by role as today), `{ active: false | true }`. `POST /api/staff` stays for create (the new PIN works at once; no forced change).
7. Safety rules on the server, in the same transaction as the change (lock the admin rows so two admins demoting each other at once cannot both succeed): the actor cannot deactivate or demote themselves; the last active admin cannot be deactivated or demoted; names stay unique case-insensitively including deactivated accounts (`findStaffByName` already does this). Clear 409/400 messages the page can show.
8. Deactivated accounts: `authenticateStaff` returns nothing (dashboard 401 on the next request; login refused with the same message as a wrong PIN); `hashesForEvent` leaves them out; the event staff list and **Add** hide them. A `pin_reset = 'admin'` account follows the existing must-change-PIN flow (`allowPinReset` routes only) and is cleared when the person sets their own PIN.
9. Every change above and `createStaff` write one `audit_log` row in the same transaction (`server/audit.ts`).
10. `scripts/create-admin.ts --if-exists reset` also clears `deactivated_at` and writes `staff.recovered` with no actor; update its usage text. `setup.bat` needs no change.

### C. Staff page

11. "Staff" nav link next to Events, admin only. Table: name, role, status tag, events assigned. Row menu: change role; reset PIN (dialog asks for the temporary PIN and explains the person must choose a new one at their next login); deactivate (dialog says they lose dashboard and scanner access within about 10 s and their records stay); reactivate. Deactivated accounts listed last, filterable.
12. "Create" form (name, role, PIN with the rule shown per role).
13. Banner when there is exactly one active admin: "Only one admin. If they forget their PIN, recovery needs server access (setup guide 1.7). Add a second admin." with a button to the create form.
14. History list (newest first, paginated) of audit rows: time, who ("server command" when no actor), what, whom.
15. Event Setup tab: remove "Create and add"; keep Add / Remove; add a "Manage accounts" link to the Staff page.

### D. Ticket-type form wording (no rule changes)

16. `TypeFields.tsx`: "Places" → "Tickets available" (hint stays "Leave blank for no limit"; error text to match); "How many times (2–63)" → "Entries per ticket (2–63)"; add a summary line under the type: "N tickets · up to M entries each" / "· one entry" / "· re-entry any number of times", "No limit" when blank. Update the matching totals wording in `EventForm.tsx` ("places in total" → "tickets available in total").
17. Early-entry box shows only when the type has at least one time slot; label "Let them in up to [15] minutes before their time starts". Keep the stored value (default 15) when slots are removed so nothing breaks on save.

### E. Tests and docs

18. Vitest: each safety rule (including the concurrent demotion case), deactivated login and next-request refusal, deactivated and `admin`-reset staff absent from `hashesForEvent`, PIN reset flow end to end, one audit row per change and none on a refused change, script reactivation.
19. e2e: Staff page create → reset PIN → person forced to change → deactivate → session refused → reactivate; the one-admin banner; no-scrollbar spec at 390x844 and 360x740; update any e2e that used "Create and add" or the old labels.
20. `docs/setup-guide.md`: 1.7 mentions the Staff page for everyone after the first admin and the one-admin warning; 5.2 creates accounts on the Staff page and assigns with Add; the troubleshooting row "a forgotten PIN has no reset in v1" now says: an admin uses Reset PIN on the Staff page; if no admin can log in, run `create-admin.ts --if-exists reset` (also reactivates).

## Done when

The plan's M13 "Done when" holds; `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` pass. Leave phone and desktop screenshots of the Staff page and the ticket-type form under `plans/m13-staff-accounts/screenshots/`.

## Summary for reviewer

(builder-1 fills this in)

## Fix requests

(none)

## Blocker

(none)
