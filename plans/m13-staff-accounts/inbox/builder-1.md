# builder-1 — m13-staff-accounts

**Status:** DONE
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

**Files changed:**
- Core: `packages/core/src/db/mysql.ts` (staff.deactivated_at, `pin_reset` check adds `admin`, new `audit_log`), `packages/core/src/db/sqlite.ts` (`deactivated_at` column only), `packages/core/src/api/cloud.ts` (zod: update/list/log), migrations `drizzle/mysql/0008_m13_staff_accounts.sql` + `drizzle/sqlite/0007_m13_staff_deactivated.sql` (+ snapshots/journals).
- Server: `server/{audit(new),staff,auth,pins,eventStaff}.ts`, `app/api/staff/{route,[id]/route,log/route}.ts`, `app/api/auth/login/route.ts`, `scripts/create-admin.ts`.
- UI: `app/(dash)/staff/page.tsx` (new), `app/(dash)/page.tsx` (Staff link), `events/[id]/_tabs/Setup.tsx`, `_components/{TypeFields,EventForm,Shell}.tsx`, `_lib/types.ts`, `dashboard.css` (`ul.plain`).
- Tests/docs: `apps/web/test/m13-staff-accounts.test.ts` (new), `auth.test.ts`, `event-form.test.ts`, `e2e/staff.spec.ts` (new, incl. SHOTS-only screenshots), `e2e/no-scrollbars.spec.ts`, `e2e/dashboard.spec.ts`, `docs/setup-guide.md`. Screenshots under `plans/m13-staff-accounts/screenshots/`.

**What was done:**
- A: `staff.deactivated_at`, `pin_reset = 'admin'`, `audit_log` (indexes on (target_kind,target_id,at) and at), zod schemas. SQLite: only the `deactivated_at` column was added, because `packages/core/test/db.test.ts` requires column parity; its `pin_reset` check was left as is since the hub never receives deactivated or `admin`-reset staff (`hashesForEvent` filters both).
- B: `GET /api/staff`, `PATCH /api/staff/[id]` (role | reset_pin | active), `GET /api/staff/log` (paged, newest first). Safety rules run in one transaction that locks every staff row in id order (no deadlock, no two-admin race); each change and `createStaff` writes one audit row in that transaction; refused changes write none. Deactivated: `authenticateStaff` undefined, login refused identically to a wrong PIN, out of `hashesForEvent`/event staff list, Add refused. `resetStaff` (script) clears `deactivated_at` and logs `staff.recovered` with no actor.
- C: Staff page (table, filter, row menu with in-page dialogs, create dialog, one-admin banner, paginated history); Setup tab lost "Create and add" and links to Staff.
- D: new labels, summary line (`type-summary`), early-entry box only with a slot. Early entry is only validated when the type has a slot (a stored value stays on save otherwise).
- E: 14 Vitest cases for the safety rules (incl. concurrent demotion), deactivation, PIN reset flow, hashesForEvent, audit rows, script reactivation; e2e flow, banner, Setup tab, form wording, no-scrollbar spec for Staff page, create dialog and row menu at 390x844 and 360x740. Full `bun run test:e2e` passed (34/34); lint, `tsc --noEmit` and `bun run test` pass.

**What to check:**
- Last-admin rule is reachable through the route only when the actor is not the target, which the route can't produce (actors are admins and self-changes are refused first); it is unit-tested through `updateStaff` directly. The route-level concurrent test (two admins demoting each other) passes with one 200 and one 403/409.
- Promoting a staff member to supervisor/admin does not flag a short PIN until their next login (same as before; `settleLogin` handles it). Possible follow-up.
- `claim.ts` (override path) does not check `deactivated_at` for a `staff_id`; phones drop deactivated supervisors at the next sync. Not in my owned files, listed as a follow-up.
- To run e2e in this sandbox I symlinked `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` to the installed Chromium 1243 (outside the repo). The "hub setup on the hub's own dashboard" no-scrollbars case depends on hub.spec having run first (it passes in the full run, fails when run alone; pre-existing).

**F1 (deactivated staff on claims and uploads):**
- Files: `server/claim.ts`, `hub/claim.ts`, `server/stats.ts` (new `deactivatedScans`, used by `listConflicts`), `server/dashboard.ts` (`reviewConflict` accepts flagged scans), `packages/core/src/api/cloud.ts` (conflict rows gain `result` and `deactivated_account`), `Conflicts.tsx`, new `test/deactivated-scans.test.ts`.
- VM: `checkRequest` refuses a `staff_id` with `deactivated_at` set: 403 `staff_deactivated` for scans, exits and overrides. Hub: its staff copy keeps the row with `pin_hash = ""` once the VM stops listing the account (deactivated or unassigned), so the hub refuses any `staff_id` with an empty hash with the same 403 `staff_deactivated` (replaces the old override-only "not active at this hub" check). No SQLite schema change.
- Offline uploads (`POST /api/scans`, hub `POST /api/sync/scans`) are stored unchanged. The Conflicts list also shows scans whose `staff_id` was deactivated at `scanned_at`, computed at read time from the `audit_log` windows (`staff.deactivated` opens, `staff.reactivated` / `staff.recovered` closes), so a reactivation before the scan time clears it. Tag "Override by a deactivated account" plus the staff name and deactivation time.
- Check: the flag is computed from the VM clock's audit time vs the phone's `scanned_at`. The hub's own Conflicts list and the Live conflict counters do not include these (the hub has no audit log; the VM list does once the hub uploads). Scans are compared by scan time only, so an online-recorded scan before deactivation is never flagged.
- Tests: 4 new (VM online refusal incl. override, offline override after deactivation stored and flagged while one before is not, reactivation window, hub refusal after sync). lint, tsc, `bun run test` pass; e2e not re-run (only the Conflicts tab markup changed).

**Conflicts resolved:** (none)

## Fix requests

### F1. Overrides and scans by deactivated staff (planner, 2026-10-28)

**Status:** DONE

User decision: close the gap you listed under "What to check" in this milestone. A phone that stays offline keeps a deactivated supervisor's PIN hash until it syncs, so it can still record overrides.

1. **Online claims** (`apps/web/src/server/claim.ts`, around the `body.staff_id` lookup; and `apps/web/src/hub/claim.ts`): a `staff_id` whose account is deactivated is refused with 403 `staff_deactivated` ("this account was deactivated"), for overrides and for normal scans. On the hub, check what its staff copy holds after a sync (rows replaced, or `deactivated_at` set) and make the hub refuse the same way; say which in your summary.
2. **Offline scans uploaded later** (`POST /api/scans` in `apps/web/src/server/sync.ts`, and the hub's upload path to the VM): do NOT drop or reject them. The person is already inside, and the scan record must stay accurate. Store them as today, but flag any override (or scan) whose `staff_id` was deactivated before the scan's time so it shows on the event's Conflicts tab (or the closest existing review list) as "Override by a deactivated account", with the staff name and the deactivation time. Use the `audit_log` `staff.deactivated` row or `deactivated_at` to compare. If the account was reactivated after the scan time, compare against the deactivation window that covers the scan time.
3. **Tests:** online refusal on the VM and on the hub; an offline override uploaded after deactivation is stored and flagged; one recorded before deactivation is not flagged.
4. Update `## Summary for reviewer` (add a short F1 part). Then fire the reviewer with `branch: m13-staff-accounts` as usual; PR Sealis04/Events_QR#27 picks up the push.

Not in scope: re-checking the PIN rule on promotion (logged as a follow-up).

## Blocker

(none)
