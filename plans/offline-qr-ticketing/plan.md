# Offline QR Ticketing — Build Plan

Approved 2026-10-21. Source spec: `docs/spec.md`, exported from [the Claude Docs spec](https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7) (rev 48). Visual plan: [Build Plan](https://claude.ai/artifact/ESJVqp6ZRnBscEpacn2WWo).

The spec is the source of truth for token format, entry rules, claim logic and sync. **Where this plan and the spec differ, this plan wins.** The differences are all in "Deployment and stack": the spec's cloud services are replaced by a self-hosted VM.

## Deployment and stack

No cloud services. Everything is self-hosted.

| Part | Choice |
|---|---|
| Server ("cloud" in the spec) | Your VM, behind Nginx Proxy Manager with an open port forward; DNS on Cloudflare |
| App | **Next.js** (App Router, TypeScript): admin dashboard, QR generator, scanner PWA and all APIs as route handlers, in one app |
| Server database | **MariaDB** on the VM |
| Venue hub | The same Next.js build run with `APP_MODE=hub` on a mini PC or Pi 5, using **SQLite** (better-sqlite3, WAL) |
| ORM / migrations | Drizzle, with one schema for MariaDB and SQLite |
| Background work | A small Node worker from the same repo (`APP_MODE=worker`) for the email queue, sync loops and the retention job |
| Signing key | Ed25519 key file on the VM, encrypted at rest with a passphrase from env, loaded only by the signing module. Never on the hub or phones |
| Event AES keys | Generated per event on the VM, stored encrypted in MariaDB, and delivered to enrolled devices |
| Email | Gmail API through the Workspace service account (domain-wide delegation, sending as one mailbox). Queued and throttled to stay under about 2,000 messages a day |
| Crypto | libsodium (Ed25519) + WebCrypto AES-256-GCM, shared by server, hub and browser |
| QR decoding | BarcodeDetector where available, with ZXing-WASM fallback |
| Packaging | Docker Compose: `app` + `worker` + `mariadb` on the VM; `app` (hub mode) on the hub |

### Hub HTTPS and DNS
- Cloudflare record `hub.<domain>` points to the hub's LAN IP, set to DNS only (not proxied).
- The hub gets a Let's Encrypt cert through the Cloudflare DNS-01 challenge (Nginx Proxy Manager on the hub, or certbot-dns-cloudflare) and renews it while it has internet.
- The venue router (or dnsmasq on the hub) answers `hub.<domain>` locally, so phones still find the hub with the internet down.
- This replaces the spec's self-signed cert pinning, which browsers can't do.

### Data flow
- **Before the event:** staff generate tickets on the VM; the worker emails them; the hub and phones download the ticket list and keys.
- **During:** phones talk to the hub over venue Wi-Fi. The hub syncs with the VM whenever internet is up. If the hub is unreachable, phones validate alone.
- **After:** the hub uploads all scans to the VM, which flags double admits.

## Team and loop

Follows the Agent Team Protocol in `CLAUDE.md`, using the existing Builder 1 and Reviewer Routines.

- Each milestone gets a feature branch `mN-<slug>` from `main`, with its tasks in `plans/<branch>/inbox/builder-1.md`.
- **Builder 1** builds the milestone on that branch, then fires the Reviewer.
- **Reviewer** either fires Builder 1 with fix requests, or approves and opens a PR to `main`.
- **Planner** then sets up the next milestone's branch and fires Builder 1.

## Repo layout (set up in M1)

```
packages/core   token lib, setup-QR codec, entry/claim rules, zod schemas, Drizzle schema
apps/web        Next.js app: server mode, hub mode, admin + scanner routes
apps/worker     email queue, sync loops, retention job
docker/         compose files for the VM and the hub
```

bun workspaces, TypeScript strict, Vitest, ESLint + Prettier. `docker compose up` runs MariaDB locally for development.

## Milestones

### M1 — Core tokens and shared contracts (`packages/core`)
- Monorepo scaffold and a check script (`bun run lint`, `bunx tsc --noEmit`, `bun run test`).
- Token lib: the spec's 34-byte payload; Ed25519 sign; AES-256-GCM with aad `EVT1`; Base45; `EVT1:` prefix. Runs in Node and browsers.
- `DEV1:` setup-QR codec (event id, one-time code, hub URL; no keys).
- Helpers: entry_rule encode/decode, gate_mask, slot minutes; pure claim/exit decision functions shared by the hub and the offline scanner.
- Drizzle schema for events, ticket_types (with `issued` counter), tickets, devices, scans, enrolment codes, email queue; migrations for MariaDB and SQLite.
- Zod schemas for every server and hub endpoint in the spec's API tables.
- **Done when:** test vectors pass for round-trip, tampered byte, wrong key, wrong event, wrong gate, out-of-slot and expired key_id; the encoded token is about 189 characters; core has no Node-only imports; migrations apply to both MariaDB and SQLite.

### M2 — Server issuance on the VM (`apps/web` server mode, `apps/worker`)
- Staff auth (PIN hashed with argon2id), events, gates, ticket types.
- `POST /api/events/{id}/tickets`: the spec's capacity transaction on MariaDB (`UPDATE … WHERE issued < capacity`, check rows affected), idempotency key, batch quantity, `issued_by`.
- Signing module that loads the encrypted key file. Deterministic re-send (stored nonce). Cancel and transfer bump `updated_at`.
- Email queue + Gmail API sender (service account credentials JSON from env path, never committed); throttle and retry. CSV import.
- `/api/devices/enroll`, `GET /api/sync/tickets`, `POST /api/sync/scans`, `GET /api/events/{id}/stats`.
- Docker Compose for the VM; a short `docs/deploy-vm.md` covering Nginx Proxy Manager and Cloudflare.
- **Done when:** a parallel test cannot oversell a capped type; a generated QR decodes with M1; re-send returns a byte-identical token; a test email sends through a Gmail API mock.

### M3 — Online scanner (`apps/web` scanner routes)
- PWA manifest + service worker caching the scanner routes; setup-QR enrolment; ready screen ("Gate A · Entry").
- Camera scan: BarcodeDetector, ZXing-WASM fallback.
- The spec's validation order and result screens (green, blue, grey, red, amber), 3 s debounce, manual search, connection pill, Entry/Exit toggle for role "both".
- `navigator.storage.persist()` requested at enrolment.
- Claims go to the VM for now.
- **Done when:** frame-to-result is under 300 ms on a mid-range phone; the scanner reloads and opens with the network off; every result state has a test.

### M4 — Venue hub and sync (`apps/web` hub mode, `apps/worker`)
- Hub mode on SQLite; the atomic `/claim` and `/exit` SQL from the spec.
- `/enroll` working offline from cached codes.
- The four sync loops (hub to VM pull/push in the worker; phone to hub), monotonic `(updated_at, id)` cursors, idempotent writes, hub time for clock sync.
- Scanner talks to the hub first.
- Hub Docker Compose and `docs/deploy-hub.md`: DNS-only Cloudflare record, DNS-01 cert, local DNS override on the venue router.
- **Done when:** the concurrency test passes (20 simulated devices claiming the same 100 tickets gives exactly 100 admits); the hub keeps admitting with its uplink cut.

### M5 — Offline mode (`apps/web`, hub)
- IndexedDB ticket table (encrypted at rest), persistent outbox, 800 ms hub timeout with retry on every scan.
- Offline entry and exit with the shared `packages/core` rules; 60 s offline beep and orange banner.
- Hub conflict flagging: earliest `scanned_at` is canonical, the later row gets `conflict = true`, dashboard alert.
- **Done when:** the chaos test (5,000 scans with random hub and access-point cuts) reconciles and every conflict is flagged.

### M6 — Dashboard (`apps/web` admin routes)
- Event workspace and QR generator UI: Email, Download PNG, Print/PDF, Generate another.
- Live check-ins (total, per gate, per type, scans per minute), device panel, conflict feed, supervisor overrides, Devices page with setup QR.
- Works against the VM before and after the event, and against the hub during it.
- Retention job: names and emails set to NULL 1 year after the event; scans deleted after 3 years.
- **Done when:** the dashboard works against the hub with the uplink down.

### Wrap-up — Dress rehearsal
Builder 1 writes `docs/runbook.md` (the spec's event-day runbook as a checklist, updated for the VM and hub) and `docs/field-test.md` (50 printed tickets, cracked screens, dim screens, paper). People run these; no code.

## Decisions after M2 (2026-10-21)

- Cancelling a ticket frees its place (`ticket_types.issued` goes down by 1). A cancelled reservation starts over with a new QR through the normal generator. Transfer stays net-zero.
- Old signing secrets are kept only while an upcoming event uses that key generation, then deleted automatically; public keys stay.
- After M3 (accepted 2026-10-22): manual-search admits need a supervisor PIN; staff PIN login on the phone needs the network until M5 adds offline login; a rescanned single-entry ticket shows "Already used".
- After M4 (2026-10-22): setup codes made for the hub stay valid until the event ends (single use) so phones can be set up offline at the hub; normal on-screen codes keep the 10-minute expiry. Only hubs may upload scans to the VM (#5).
- After M5 (2026-10-22): supervisor and admin PINs need 8+ digits and use slower hashing, because phones hold PIN hashes for offline login; phones get hashes only for the event's assigned staff (#8); after a lost phone, revoke it and rotate the affected PINs.
- After M7 (2026-10-23): "Set up again" on a phone must wipe it (uploading queued scans first); the hub dashboard gets a "Pull tickets now" button. Both go into M8.
- From M3 on, the reviewer writes fix requests into `plans/<branch>/inbox/builder-1.md` as well as GitHub issues.

### M8 — Step-by-step setup guide (added 2026-10-22)
One guide, `docs/setup-guide.md`, for an IT person doing the first install from zero. It replaces nothing: it links the deeper `docs/deploy-vm.md` and `docs/deploy-hub.md` where useful, but can be followed on its own top to bottom.
- Prerequisites checklist: VM specs and OS, domain on Cloudflare, Gmail Workspace admin access, hub hardware (Pi 5 / mini PC, SSD, UPS, router, access points), phones.
- VM: install Docker, clone the repo, fill `.env` (every variable explained, which are secrets), generate the signing key and event-key master, `docker compose up`, run migrations, create the first admin (8+ digit PIN), backups.
- Nginx Proxy Manager: proxy host for the app, SSL, port forward; Cloudflare DNS record for the app.
- Gmail: create the service account, domain-wide delegation scope, key file, sender mailbox, send a test email.
- Hub: OS install, Docker, `docker/compose.hub.yml`, Cloudflare DNS-only `hub.<domain>` record, DNS-01 certificate and renewal, router or dnsmasq local DNS override, `scripts/hub-enroll.ts`, standby hub.
- First event end to end: create event, gates, ticket types, staff assignment; generate a test ticket; print hub setup codes; set up a phone; scan it; check the dashboard; pull the internet cable and scan again.
- Every step ends with a "Check" (a command or what you should see) and a "If it fails" line.
- Troubleshooting table: common errors (certificate not trusted on phones, `hub.<domain>` not resolving offline, Gmail 403 / delegation, migrations, phone stuck on Cloud-only, clock drift) with fixes.
- Upgrading to a new version and rotating keys.
- **Done when:** the reviewer follows the guide in a clean sandbox as far as it can (everything except real Cloudflare, Let's Encrypt, Gmail and router steps) without needing any knowledge outside the guide, and every command in it runs.

### M9 — Test copy on the VM (added 2026-10-26, built by the planner on the user's request)
A separate copy of the system beside production, at `test.<domain>`, for trying new versions, training and rehearsals.
- `docker/compose.test.yml`: Docker project `events-qr-test`, own MariaDB volume (`events_qr_test`), own `.env.test` and `.secrets-test`, app on 3002, Mailpit (`axllent/mailpit:v1.31.1`) as the mail catcher on loopback 8025.
- `INSTANCE_LABEL` setting: red "TEST COPY" banner on every dashboard page and on the scanner (via `/api/health`, remembered for offline), `[TEST]` in email subjects.
- `MAIL_TRANSPORT=smtp` (with `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`): the worker sends over plain SMTP to Mailpit instead of the Gmail API.
- `scripts/test-reset.ts`: empties the test database, re-migrates, creates Test Admin / Test Supervisor / Test Staff and seeds the 50-ticket rehearsal with its sheet. Refuses unless `--yes`, `INSTANCE_LABEL` set, `DB_NAME` contains "test" and `PUBLIC_URL` is not `PRODUCTION_URL`.
- `docs/test-setup.md`: one-time setup, everyday use, upgrading the test copy first, switching the standby hub between test and production.

### M10 — Test copy on a Windows PC through a Cloudflare Tunnel (added 2026-10-26, built by the planner)
- Optional `tunnel` service (`--profile tunnel`) in `docker/compose.test.yml`: `cloudflare/cloudflared:2026.10.0`, token from `CLOUDFLARE_TUNNEL_TOKEN` in `.env.test`, public hostname pointed at `http://app:3000`.
- `docs/test-setup.md` section 5: WSL2 + Docker Desktop, clone inside Ubuntu, tunnel creation in Zero Trust, Mailpit at `localhost:8025` on the PC, keeping the PC awake, optional Cloudflare Access, tunnel troubleshooting. No venue-hub testing this way.

### M11 — UI refresh, phone login that lasts, safer revoke, router-independent hub DNS (added 2026-10-26)
User feedback after trying the test copy: logging in again on the phone is a pain, "Revoke and rotate" is too easy to hit, the UI looks rough and breaks on phones. Target screens: `plans/m11-ui-refresh/mockups/` (exported from https://claude.ai/artifact/5FmnJtFjb4RqeNZ28DDfq1, approved 2026-10-26).
- **Phone login lasts** until the staff member signs out, the event day ends, the phone is revoked or wiped, or the event ends. It survives closing the app, locking the screen and rebooting. No idle timeout and no biometrics for now (revisit once it is known whether phones are personal or shared).
- **Revoke:** one Revoke action; the confirm dialog has a "This phone was lost or stolen" checkbox that adds the PIN rotation and names who must change their PIN.
- **Gate phone:** event name and gate in the header; big Entry/Exit toggle; one full-width "Find a ticket by name"; everything else in a ⋯ menu (switch staff member, camera help, sign out, set up again behind a confirm); full-screen ADMITTED / refused results with a headline, holder, type, entry count, what to do, and a big "Next scan"; device label instead of id; camera-blocked retry with iOS/Android steps; today's in/out counts.
- **Dashboard:** new look across all pages per the mockups. New event and Setup: numbered cards, gates as draggable tags, ticket types as summary cards with plain-language editing (entry count, gate chips, day + clock times, early entry checkbox, preview sentence, presets), sticky create/save bar, time-zone dropdown. Events list as cards with status and progress. Event name as page title, one-line tab strip. Tickets: search + filters, sort, pagination (50/page), ⋯ row menu, transfer form, CSV export. Live stats tiles with capacity %, stale-data and hub-offline banner. Devices: plain wording, "Quiet" explained. Plus the smaller polish items in the builder inbox.
- **Phones: no scrollbars at all.** Nothing scrolls sideways at 360–430 px; the scanner screens fit one screen with no scrolling; any scroll container on phones hides its scrollbar.
- **Hub DNS for any router:** setup guide section 4.6 rewritten around the hub's `dns` service (router only needs DHCP reservation + DNS server), with a TP-Link Archer example, the Ubuntu port-53 (`systemd-resolved`) conflict, and what happens when the hub is off.
- **Done when:** the mockup screens are matched (layout, wording, behaviour), Playwright at 390×844 and 360×740 finds no horizontal overflow and no visible scrollbar on any page, the phone login survives a reload and a browser restart, and lint, typecheck, unit and e2e tests pass.

### M12 — In-app hub setup checklist with live checks (added 2026-10-26, approved)
For the IT person. A "Hub setup" page on each event (a hub is enrolled per event, as a `devices` row of kind `hub`), admin only, in the M11 look. Two parts; every step has a **Check** button that tests it for real and shows pass/fail with the fix; anything a browser or server cannot test shows the command to run with a copy button.
- **Part 1, at the office (internet):** (1) hub machine and stack running: the hub answers at its address; (2) `hub.<domain>` record: the VM resolves it through public DNS to a private IP and not to Cloudflare's proxy; (3) certificate valid, days left, warn under 30; (4) link the hub: make the hub setup code from the page, copyable `hub-enroll` command; check the hub is enrolled, seen recently and has pulled tickets.
- **Part 2, at the venue (venue Wi-Fi):** (5) local DNS (router or the hub's `dns` service): from the browser on the venue Wi-Fi, `https://hub.<domain>/api/health` answers in hub mode; (6) tickets and staff on the hub match the VM; (7) one phone set up through the hub reports "Hub"; (8) internet unplugged, a test scan reaches the hub and reaches the VM after reconnecting.
- Part 2 also works on the hub's own dashboard when the venue has no internet (checks that need the VM say so and are skipped there).
- Each check's last pass/fail time and who ran it are stored per hub (a record that the hub was tested before the event).
- Fix from M11: the New event / Setup sticky bar matches the mockup (dark, card width).
- **Done when:** a reviewer takes a fresh simulated hub from step 1 to step 8 using only the page; every check has a passing and a failing test; lint, typecheck, unit and e2e tests pass and the no-scrollbar spec covers the new page.

### M13 — Staff accounts page, activity log, clearer ticket-type form (added 2026-10-28)
Accounts are global (one name, PIN and role across events); event assignment stays on each event. User decisions 2026-10-28:
- **Staff page** in the VM dashboard (admin only, not on the hub): create, list, change role, reset PIN, deactivate, reactivate. The event Setup tab keeps Add / Remove for assignment and links to the Staff page; "Create and add" moves to the Staff page.
- **New accounts:** the PIN the admin sets works at once (no forced change), so staff can scan on day one.
- **PIN reset:** the admin sets a temporary PIN and the person must choose a new one at their next dashboard login (same flow as `weak` / `rotate`). A temporary PIN never reaches phones or the hub.
- **Deactivate:** refused on the dashboard at the next request; dropped from phones and the hub at the next sync. Tickets, scans and assignments stay. Reactivation is allowed.
- **Safety rules:** an admin cannot deactivate or demote themselves; the last active admin cannot be deactivated or demoted; names stay unique including deactivated accounts.
- **Lockout:** `scripts/create-admin.ts --if-exists reset` also reactivates the account; the Staff page warns when only one active admin exists. No recovery codes.
- **Activity log:** new `audit_log` table; this milestone logs staff-account changes only (created, role changed, PIN reset, deactivated, reactivated, recovered by server command), shown as a history list on the Staff page. Generic columns so other admin actions can be added later without a schema change.
- **Ticket-type form:** "Places" becomes "Tickets available"; "How many times" becomes "Entries per ticket"; a summary line ("2 tickets · up to 3 entries each"); the early-entry box only shows once the type has a time slot, worded "Let them in up to N minutes before their time starts". Rule logic unchanged.
- **Done when:** each safety rule, deactivation (login, next request, sync), PIN reset flow, audit rows and the script's reactivation have tests; setup guide 1.7, 5.2 and the forgotten-PIN row are updated; lint, typecheck, unit and e2e tests pass and the no-scrollbar spec covers the Staff page.

### M14 — Hub setup page and reset (added 2026-10-28)
The hub links itself to an event from its own web page instead of a command, and goes back to that page after the event. User decisions 2026-10-28:
- **Setup screen:** while the hub is not linked, every hub page redirects to `/setup`, which asks only for the setup code (made on the server's Hub setup tab). Linking runs the existing link + first full sync, then goes to `/login`. Once linked, `/setup` is gone. The hub always has internet at first setup.
- **Server address:** fixed in the hub's env as `HUB_SERVER_URL` (written by `setup.bat`), shown read-only on the page, never typed there, so nobody on the venue LAN can point the hub at a fake server. Changing server = edit the env file and restart.
- **One event per hub.** To move on, **Reset hub** on the hub dashboard wipes all event data and keys and returns to `/setup`; every event needs a fresh code.
- **Who resets:** supervisors and admins. **Blocked while unsent scans (or devices, checks) are waiting**; only an admin can force it, after a warning that those records are lost.
- **Credential:** the reset asks the server to revoke the hub's own credential (new hub-only endpoint). If the server is unreachable (forced reset only), the hub still wipes and tells the admin to revoke it on the server's Devices tab, which must offer Revoke for hub rows.
- **setup.bat:** asks for the server address and writes `HUB_SERVER_URL`; its "Link the hub now" step is dropped in favour of the page. `scripts/hub-enroll.ts` stays as the fallback and defaults to `HUB_SERVER_URL`.
- **Done when:** a fresh hub goes unlinked → code on `/setup` → login → reset → `/setup` using only the browser; link refused once linked and rate-limited; reset blocked/forced by role and revokes on the server; the wipe leaves no event data, keys or sessions; lint, typecheck, unit and e2e tests pass and the no-scrollbar spec covers `/setup` and the reset dialog.

### M15 — Guided hub network setup (added 2026-10-28)
From the user's first real hub test on a Windows PC at home (2026-10-28), where every step after "the hub runs" had to be done by hand and failed silently: no hub name asked, port 53 taken on Windows, firewall, router DNS not set, phones on mobile data, a dropped login cookie over `http://`, and a setup QR pointing at `localhost` because `HUB_URL` was empty. User decisions 2026-10-28:
- **setup.bat, hub (dev and prod):** cannot finish without `HUB_DOMAIN` and `HUB_LAN_IP`. The name must look like a real domain (not `example.org`/`example.com`); the IP must be one of this PC's own IPv4 addresses on a real adapter (not WSL, Hyper-V, Docker or loopback), offered as a pick list. `HUB_DNS_BIND` is always the LAN IP. The DNS service is always started (recreated when the name or IP changed) and checked with `nslookup <name> <IP>`; setup does not end until it answers or the user explicitly chooses to stop and fix it.
- **Firewall:** setup offers to make the network Private and add inbound rules for TCP 80, 443, 53 and UDP 53 (one elevated PowerShell prompt).
- **"Do this now" box** at the end of every hub run, including re-runs that keep the env file: the router steps (reserve the IP, Primary DNS = hub IP, Secondary empty), phone tips (mobile data off, Private DNS off, open `https://<name>`), `HUB_URL=https://<name>` for the web app, and the exact commands to restart the DNS service and to test it. The same box is written to a text file next to `setup.bat` so it can be found later.
- **setup.bat, web app (dev and prod):** asks whether phones will use a venue hub; if yes, `HUB_URL` is required (https, real name).
- **App warnings:** the Devices and Hub setup tabs warn when the event has a linked hub but `HUB_URL` is empty or points at `localhost`/a private-only name; the login page says "open this page with https://" when the login succeeded but the cookie was dropped on plain http; the phone's setup error names which server it could not reach instead of looping back silently.
- **Docs:** setup guide section 4 gets a "Testing a hub on a Windows PC" part with these pitfalls.
- **Done when:** a fresh Windows run of `setup.bat` → Hub ends with the DNS answering and the box shown, and cannot end with the name or IP missing; the app warnings have tests; lint, typecheck, unit and e2e tests pass.

## Decisions after the test copy (2026-10-26)
- Staff login on phones lasts until sign-out or the end of the event day ("unli" for now); biometrics only together with an idle timeout, later.
- "Revoke and rotate" worked as designed; the UI changes so rotation is an explicit checkbox in the revoke dialog.
- The venue router is unknown (TP-Link of some kind): the hub DNS setup must work with any router.
- Mobile UI has no scrollbars anywhere.
- M12: the hub setup page is for the IT person, in two parts (office with internet, then venue Wi-Fi), with live checks.

## Out of scope for v1
Payments and online checkout, resale, rotating QR codes, wallet passes, seat maps.

## Rules for every milestone
- Stay inside the milestone's scope; note anything else under "Follow-ups" in `INBOX.md`.
- No secrets in the repo: signing key file, key passphrase, Gmail service-account JSON, Cloudflare token and DB passwords come from env or mounted files (gitignored).
- Each milestone ends with lint, typecheck and tests green.
