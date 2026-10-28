# builder-1 — m15-hub-network-setup

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`setup.bat` (and an optional helper `scripts/setup-hub-network.ps1` if batch gets unwieldy; keep it plain PowerShell 5.1, no modules), `docker/compose.hub.yml` (only if needed), `apps/web/src/app/(dash)/login/page.tsx`, `apps/web/src/app/(dash)/events/[id]/_tabs/{Devices,HubSetup}.tsx`, `apps/web/src/app/_lib/hubSetup.ts`, `apps/web/src/server/{hubSetup,devices,config}.ts` and any small new server helper, `apps/web/src/scanner/sync.ts`, `apps/web/src/app/scan/ScannerApp.tsx`, `packages/core/src/api/` (only if a response gains a field), `docs/setup-guide.md`, `docs/deploy-hub.md`, tests in `apps/web/test/` and `apps/web/e2e/`. Add `HUB_NEXT_STEPS.txt` (the generated file) to `.gitignore`. List anything else under Follow-ups in `plans/m15-hub-network-setup/INBOX.md`.

## Shared files

(none)

## Tasks

M15 of `plans/offline-qr-ticketing/plan.md` (read the M15 section and `PROJECT_STATE.md`, which lists exactly what went wrong in the user's test). Keep `setup.bat` re-runnable and its existing Keep/Replace env behaviour.

### A. setup.bat — hub (dev and prod)

1. Both `:hub_dev` and `:hub_prod` always ask, and require:
   - **Hub name** → `HUB_DOMAIN`. Reject empty, anything without a dot, `example.org`/`example.com` and their subdomains, and values with `http`, `/` or spaces. Explain: "the name you put in Cloudflare, e.g. hub.yourdomain.com".
   - **This PC's LAN address** → `HUB_LAN_IP`. List this PC's IPv4 addresses on up adapters, excluding loopback, link-local `169.254.*`, and adapters whose name or description matches vEthernet/WSL/Hyper-V/Docker/VirtualBox/VMware/Loopback; let the user pick by number (one address → confirm it). Refuse an IP that is not on this PC. Remind: reserve this IP in the router.
   - Set `HUB_DNS_BIND` to the same IP (always on Windows; this avoids the "0.0.0.0:53 already in use" error).
   - With **Keep**, read these from the env file; if any is missing or invalid (e.g. the IP is no longer on this PC), ask for it and write it with `:setenv`. The setup must not reach its end for a hub without all three valid.
2. After the hub stack is up, always start the DNS service: `<compose> --profile dns up -d --force-recreate dns`. If it fails with the port error, say what holds UDP 53 (`netstat -ano -p udp` + `tasklist` for that PID) and how to free it (Mobile hotspot / Internet Connection Sharing), then offer Retry / Stop.
3. Check it: `nslookup <HUB_DOMAIN> <HUB_LAN_IP>` must return `HUB_LAN_IP` (retry a few times over ~10 s). On failure offer Retry / Show logs / Stop; Stop ends with the failure message (`:fail`), not "Done".
4. **Firewall (optional, one prompt):** "Open the Windows firewall for the hub (needs admin)?" Y → one elevated PowerShell (`Start-Process -Verb RunAs -Wait`) that sets the active network's profile to Private and adds idempotent inbound allow rules: TCP 80, 443, 53 and UDP 53, named `Events_QR hub ...`, `-Profile Any`. Report success/decline; a decline or failure is a warning, not a stop.
5. **"Do this now" box** at the end of every hub run (new or Keep), visually separated (a line of `=`, a title, numbered steps):
   1. Router → DHCP: reserve `<IP>` for this PC; Primary DNS = `<IP>`; Secondary DNS empty. "While this PC is off, devices on this Wi-Fi cannot look up names."
   2. Cloudflare: `A` record `<first label>` → `<IP>`, DNS only (grey cloud).
   3. Nginx Proxy Manager: certificate for `<name>` with **Use a DNS Challenge** (Cloudflare token), proxy host `<name>` → the hub (dev: `host.docker.internal:<HUB_PORT>`; prod: `app:3000` when using the hub's `proxy` profile), SSL tab: Force SSL.
   4. Web app `.env`: `HUB_URL=https://<name>`, then the exact command to restart the web app for this setup type.
   5. Phones: mobile data off, Private DNS Off, open `https://<name>/scan`.
   6. If something stops working: the exact commands to restart the DNS service and to test it (`nslookup <name> <IP>`), and `https://<name>/api/health`.
   Write the same text to `HUB_NEXT_STEPS.txt` next to `setup.bat` and say so. No secrets in it.
6. Prod hub: the old "Run the hub's DNS service" Y/N question goes away (always on). Keep the NPM offer.

### B. setup.bat — web app (dev and prod)

7. Ask "Will phones use a venue hub? [Y/N]". Y → `HUB_URL` required, must start with `https://` and have a real name (same name checks as A1). N → leave it unset. With Keep: if `HUB_URL` is missing, ask the Y/N question once and write the answer.
8. At the end of the web app run, if `HUB_URL` is set, print it and remind that the hub name must match.

### C. App warnings

9. Server helper that classifies `HUB_URL`: `unset`, `local` (`localhost`, `127.*`, `host.docker.internal`, a bare IP, or `http://`), or `ok`. Expose it to the dashboard where the Devices and Hub setup tabs already load their data.
10. Devices tab and Hub setup tab: when the event has a linked (not revoked) hub and `HUB_URL` is not `ok`, show a warning: "Phones set up from this page will not find the hub: HUB_URL is <unset | value>. Set HUB_URL=https://<hub name> in the server's .env and restart it." Also add this as a failing check in the Hub setup checklist if it fits an existing step (step 7, a phone through the hub).
11. Login page: when the login call succeeded but `/api/auth/me` then fails, and `location.protocol === "http:"` and the host is not `localhost`/`127.0.0.1`, show "Open this page with https:// — over plain http the browser drops the login." instead of the supervisors message.
12. Phone setup (`enrollFromSetupQr` / `ScannerApp`): if the code was exchanged but the first sync reaches neither server, keep a clear message on the setup screen naming both addresses ("Set up at <hub>, but could not download tickets from <hub> or <cloud>. Check HUB_URL on the server and that this phone is on the venue Wi-Fi.") and note that a new setup code is needed. No silent return to the setup screen.

### D. Docs

13. `docs/setup-guide.md` section 4: new "Testing a hub on a Windows PC" subsection with the six pitfalls from `PROJECT_STATE.md` and their fixes, and update 4.3/4.6 for the new setup.bat flow. `docs/deploy-hub.md` section 5: `HUB_DNS_BIND` on Windows, and that setup.bat now always starts and checks the DNS service.

### E. Tests

14. Vitest: the `HUB_URL` classifier (unset, localhost, 127.x, host.docker.internal, bare IP, http name, https name); the Devices/Hub setup data carries the warning only with a linked hub; the phone setup error when both servers fail (message names both, device not left half-set-up).
15. e2e: login over a non-localhost http origin shows the https message (use the existing e2e setup; if a non-localhost origin is impractical, unit-test the message choice and say so); warning visible on the Devices tab with `HUB_URL` unset and a linked hub; no-scrollbar spec covers the warning banner at 390x844 and 360x740.

## Done when

The plan's M15 "Done when" holds; `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` pass. In your summary, walk through each setup.bat path in words (what it asks, what it refuses, where it ends), since the reviewer cannot run it.

## Summary for reviewer

(builder-1 fills this in)

## Fix requests

(none)

## Blocker

(none)
