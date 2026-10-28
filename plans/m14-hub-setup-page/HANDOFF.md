# Handoff — m14-hub-setup-page

Goal: a fresh hub is linked to an event from its own `/setup` page with just the setup code, and after the event a supervisor resets it back to that page. No command line needed.

Do part A (config and schemas) first, then B (link from the web), C (`/setup` page), D (server: hub revokes itself), E (reset), F (setup.bat and docs), G (tests).

Read in order: `CLAUDE.md`, `plans/m14-hub-setup-page/inbox/builder-1.md`, the M14 section of `plans/offline-qr-ticketing/plan.md`, `apps/web/src/hub/{link,state,vmsync,loops,routes,dashboard,session,http,context}.ts`, `apps/web/src/middleware.ts`, `apps/worker/src/hubMain.ts`, `scripts/hub-enroll.ts`, `apps/web/src/server/{config,deviceAdmin,devices}.ts`, `apps/web/src/app/(dash)/events/[id]/_tabs/HubSetup.tsx`, `docker/compose.hub.yml`, `setup.bat` (`:hub_dev`, `:hub_prod`, `:enroll_hub`), `docs/deploy-hub.md` sections 2, 3 and 8, `docs/setup-guide.md` section 4.
