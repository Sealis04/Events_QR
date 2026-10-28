# Handoff — m15-hub-network-setup

Goal: running `setup.bat` for a hub on Windows leaves a hub that phones on the same Wi-Fi can reach by name with no internet, or tells the person exactly what is left (router, phone) and how to fix it. The app warns about the two traps that only show up on phones (`HUB_URL` empty or local; plain `http://`).

Do part A (setup.bat hub) first, then B (setup.bat web app), C (app warnings), D (docs), E (tests).

Read in order: `CLAUDE.md`, `plans/m15-hub-network-setup/inbox/builder-1.md`, the M15 section of `plans/offline-qr-ticketing/plan.md`, `setup.bat` (whole file, especially `:hub_dev`, `:hub_prod`, `:env_file_choice`, `:setenv`, `:ensure_server_url`), `docker/compose.hub.yml` (`dns` service), `docs/setup-guide.md` section 4 and `docs/deploy-hub.md` sections 4–6, `apps/web/src/app/(dash)/login/page.tsx`, `apps/web/src/app/(dash)/events/[id]/_tabs/{Devices,HubSetup}.tsx`, `apps/web/src/app/_lib/hubSetup.ts`, `apps/web/src/server/{config,hubSetup,devices}.ts`, `apps/web/src/scanner/sync.ts` (`enrollFromSetupQr`), `apps/web/src/app/scan/ScannerApp.tsx`.
