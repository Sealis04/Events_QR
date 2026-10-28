# Handoff — m13-staff-accounts

Goal: admins manage every staff account from one Staff page, every change is logged, nobody can lock the last admin out, and the ticket-type form says what each field does.

Do part A (schema and core) first, then B (server rules and API), C (Staff page), D (form wording), E (tests and docs).

Read in order: `CLAUDE.md`, `plans/m13-staff-accounts/inbox/builder-1.md`, the M13 section of `plans/offline-qr-ticketing/plan.md`, `apps/web/src/server/{staff,auth,pins,eventStaff,http}.ts`, `apps/web/src/app/api/staff/route.ts`, `apps/web/src/app/api/events/[id]/staff/`, `apps/web/src/app/(dash)/events/[id]/_tabs/Setup.tsx`, `apps/web/src/app/_components/{TypeFields,EventForm}.tsx`, `scripts/create-admin.ts`, `docs/setup-guide.md` sections 1.7 and 5.2.
