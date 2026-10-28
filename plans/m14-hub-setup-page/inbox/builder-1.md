# builder-1 — m14-hub-setup-page

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`packages/core/src/api/` (new hub setup/reset schemas), `apps/web/src/server/config.ts`, `apps/web/src/middleware.ts`, `apps/web/src/hub/**` (new `hub/reset.ts`, changes to `link.ts`, `state.ts`, `routes.ts`, `dashboard.ts`, `session.ts`, `loops.ts`), new hub API routes under `apps/web/src/app/api/hub/`, a new `apps/web/src/app/setup/` page, the hub dashboard's reset UI, `apps/web/src/app/api/hubs/` (new `revoke-self`), `apps/web/src/server/{devices,deviceAdmin}.ts`, the Devices tab component if hub rows need a Revoke action, `apps/web/src/app/(dash)/events/[id]/_tabs/HubSetup.tsx` (text only), `apps/worker/src/hubMain.ts`, `scripts/hub-enroll.ts`, `docker/compose.hub.yml`, `setup.bat`, `docs/deploy-hub.md`, `docs/setup-guide.md`, tests in `apps/web/test/` and `apps/web/e2e/`. List anything else under Follow-ups in `plans/m14-hub-setup-page/INBOX.md`.

## Shared files

(none)

## Tasks

M14 of `plans/offline-qr-ticketing/plan.md` (read the M14 section). Use the M11 look (`dashboard.css` tokens, Dialog, in-page confirmation dialogs), keep the no-scrollbar rule on phones, and keep `packages/core` free of Node-only imports.

### A. Config and schemas (first, one commit)

1. `HUB_SERVER_URL` (optional URL) in `server/config.ts`; passed to `app`, `worker` and `tools` in `docker/compose.hub.yml` (`${HUB_SERVER_URL:-}`).
2. zod schemas in `packages/core/src/api/`: hub status (`linked`, `server_url`, event id/name when linked, unsent counts: scans, devices, checks), link request `{ code }` (no URL field), reset request `{ force?: boolean }` and reset response (`revoked_on_server: boolean`, message).

### B. Link from the web

3. `GET /api/hub/status` (public on the hub; returns only what the schema above allows, no tokens or keys).
4. `POST /api/hub/link` `{ code }`: only while the hub is unlinked (409 once linked); uses `HUB_SERVER_URL` only (clear 503 if unset); rate-limited (e.g. 5 tries per minute per client IP plus a global cap); runs `linkHubToVm` and the first `pullCycle` / `pushCycle` like `hub-enroll.ts`; maps `VmRefused` / `VmUnreachable` to plain messages (code used or expired; server unreachable, check internet and clock). Guard against two links at once (one in flight).
5. Middleware: on a hub that is not linked, every page route (`/`, `/login`, `/events/...`) redirects to `/setup`; `/setup`, `/api/hub/status` and `/api/hub/link` are allowed; scanner API unchanged. On a linked hub, `/setup` and `/api/hub/link` are not served (redirect to `/login` / 409). The middleware cannot read SQLite: use a cheap check that works there (e.g. the page/route itself redirects server-side, or a status call), and say in your summary how you did it.
6. `scripts/hub-enroll.ts`: the URL argument becomes optional and defaults to `HUB_SERVER_URL`; usage text updated.

### C. `/setup` page (hub only)

7. One card: the server address read-only, a setup-code field, **Link hub** button, progress while linking ("Linking… pulling tickets and staff"), then "Linked to <event>: N tickets" and a button to log in. Errors in plain words, including "This hub has no server address. Set HUB_SERVER_URL in its .env and restart it." Short help line: where to get a code (event → Hub setup tab, valid 10 minutes, works once).
8. On the VM (server mode) `/setup` does not exist (404).

### D. Server: hub revokes itself

9. `POST /api/hubs/revoke-self` with `route({ access: "hub" })`: sets the caller's own `devices` row `revoked = 1`; idempotent. Add it to whatever list makes hub-only routes reachable.
10. The VM Devices tab can revoke a hub row (check `deviceAdmin.ts` / the Devices panel; hub rows have no gate, so skip the rotate-PINs option or keep it as is, your call, say which).

### E. Reset hub

11. `POST /api/hub/reset` `{ force? }` on the hub dashboard: supervisor or admin session. If any of `hub_scan_outbox`, `hub_device_outbox`, `hub_check_outbox` (or other unsent queues you find) is non-empty: 409 with the counts, unless `force` and the caller is an admin.
12. Order: call `revoke-self` on the server (short timeout); then in one SQLite transaction delete all event data (tickets, ticket types, events, staff, event staff, devices, enrolment codes, scans, outboxes, hub checks) and every `hub_state` key, including `session_secret` so all sessions end. Return `revoked_on_server`. If revoke failed and it was not forced, do not wipe (409 "server unreachable"); if forced, wipe and return `revoked_on_server: false`.
13. Worker: after a wipe the loops find no link and idle quietly (no error spam), and pick up a new link without a restart (`hubMain.ts` already waits at start; make the running loops behave the same).
14. UI: **Reset hub** in the hub dashboard (where the event is shown), dialog states what will be deleted, shows unsent counts and blocks the button while they are non-zero; admins see a "Delete them anyway" checkbox with the warning. After success: the page goes to `/setup`; if `revoked_on_server` is false, show "Revoke this hub on the server: event → Devices → the hub → Revoke" first.

### F. setup.bat and docs

15. `setup.bat` `:hub_dev` and `:hub_prod`: ask "Server address" (dev default `http://host.docker.internal:<web app port from .env, else 3000>`; prod required) and write `HUB_SERVER_URL` to the env file; remove the `:enroll_hub` call and print "Open <hub URL>/setup and enter a setup code from the event's Hub setup tab." Keep `:enroll_hub` only if still used elsewhere, else delete it. Keep it re-runnable (Keep/Replace env logic unchanged).
16. `docs/deploy-hub.md`: section 2 (`HUB_SERVER_URL` in the settings table, required), section 3 (link on `/setup`, command as fallback), section 8 (Reset hub replaces `down -v` and the manual SQL revoke; keep `down -v` as the full wipe). `docs/setup-guide.md` section 4 to match. `HubSetup.tsx` step 4 text: "enter this code on the hub's setup page" with the command as the fallback copy.

### G. Tests

17. Vitest: link refused when linked / without `HUB_SERVER_URL` / body URL ignored; rate limit; concurrent link; status leaks no secrets; reset blocked for supervisor with unsent rows, forced only by admin; revoke-self marks only the caller and refuses phone tokens; wipe leaves every table empty and sessions invalid; relink to a second event shows none of the first; worker loop idles after wipe.
18. e2e (hub mode): unlinked hub → any page lands on `/setup` → enter code → login → Reset hub → back on `/setup`; no-scrollbar spec covers `/setup` and the reset dialog at 390x844 and 360x740; update any hub e2e that linked via the script if needed.

## Done when

The plan's M14 "Done when" holds; `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` pass. Leave phone and desktop screenshots of `/setup` (empty, error, linked) and the reset dialog under `plans/m14-hub-setup-page/screenshots/`.

## Summary for reviewer

(builder-1 fills this in)

## Fix requests

(none)

## Blocker

(none)
