# builder-1 — m12-hub-setup

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

New hub-setup page and components under `apps/web/src/app/`, new API routes for the checks (VM and hub), a migration and Drizzle schema for stored check results if needed (`packages/core/src/db/` + `packages/core/drizzle/mysql/` and the SQLite side if the hub stores results), their tests, `apps/web/e2e/`, the sticky bar CSS fix, and short links to the new page from `docs/setup-guide.md` section 4 and `docs/deploy-hub.md`. List anything else under Follow-ups in `plans/m12-hub-setup/INBOX.md`.

## Shared files

(none)

## Tasks

M12 of `plans/offline-qr-ticketing/plan.md` (read the M12 section). User decisions 2026-10-26: the page is for the IT person; it has two parts, done at the office with internet and then at the venue on the venue Wi-Fi; every step has a live Check. Use the M11 look (`dashboard.css` tokens, Dialog, Menu, tags) and keep the no-scrollbar rule on phones.

### A. Page and storage

1. **"Hub setup" on the event page** (admin only; a tab or a clearly linked page from Devices). Two sections, "Part 1 · At the office (needs internet)" and "Part 2 · At the venue (on the venue Wi-Fi)", eight numbered steps (below). Each step: a short explanation, the commands to run with copy buttons (filled in with this event's values: domain, hub URL, hub LAN IP if known), a **Check** button, and the result (pass with details / fail with the most likely fix, linking the matching setup-guide section). Show a progress summary at the top ("5 of 8 passed, last checked …").
2. **Stored results:** for each hub (the event's `devices` row of kind `hub`) and step: last result, details, time, and who ran it. Migration with a test. Shown on the page as a record that the hub was tested.
3. **On the hub:** the same page renders on the hub's own dashboard for Part 2 when the venue has no internet; steps that need the VM say so and are skipped, results are kept on the hub and sent to the VM with the next sync if that is simple, otherwise shown locally only (say which in your summary).

### B. The checks

Part 1 (office):
4. **Hub running:** the browser fetches `HUB_URL/api/health` (CORS is already open on health) and expects `mode: "hub"`; on failure explain the three usual causes (hub stack not up, wrong address, browser not on the same network).
5. **`hub.<domain>` record:** a VM API resolves the hub host name through public DNS (Node `dns.promises` with a public resolver such as 1.1.1.1, timeout) and passes when it gets a private (RFC 1918) address; fails with "proxied by Cloudflare: turn the cloud grey" when the answer is a Cloudflare address, and with "no record" when NXDOMAIN.
6. **Certificate:** a VM API opens a TLS connection to the hub's name at the resolved address where the VM can reach it; if it cannot (the VM is not on the hub's network, usual case), the browser check from step 4 already proves a trusted certificate, so take the pass from there, and get the expiry date from the hub (add `cert_expires_at` to the hub's health or a hub-only endpoint, read from the certificate NPM serves or from a mounted path; if that is not practical, show the `openssl s_client` command instead and say so). Warn under 30 days.
7. **Link the hub:** a button that makes the hub setup code (existing `/api/hubs/setup` flow) and shows the `scripts/hub-enroll.ts` command with it; the check passes when the event has a non-revoked hub device seen in the last 2 minutes that has pulled tickets (use the existing sync cursors / last pull data).

Part 2 (venue):
8. **Local DNS:** the browser (on the venue Wi-Fi) fetches `https://hub.<domain>/api/health`; pass in hub mode. Explain that this test only means something with the internet unplugged or from a phone whose DNS is the router; show the `nslookup hub.<domain> <router-ip>` command.
9. **Tickets and staff on the hub:** compare counts (tickets by status, assigned staff) between the VM and the hub (hub health or a small hub endpoint the browser can call; supervisor auth where data is sensitive). Pass when equal or the hub is behind by less than one pull interval, showing the last pull time.
10. **A phone through the hub:** pass when at least one scanner device of this event reported through the hub in the last 5 minutes (hub-side device data, or the VM's view of the hub's uploads).
11. **Offline scan:** guide the IT person (unplug the uplink, scan the rehearsal test ticket, plug back in) and pass when that scan exists on the hub with the uplink down and later on the VM. Use timestamps from the hub's scan record and the VM's receipt.

### C. Fix from M11

12. New event / Setup sticky bar: dark (`#111827`), same width as the cards, as in `plans/m11-ui-refresh/mockups/Main.dc.html`.

## Done when

The plan's M12 "Done when" holds: a fresh simulated hub (the e2e hub setup from M4/M8) goes from step 1 to step 8 using only the page (record in your summary which checks you exercised against real processes and which with fakes); every check has unit tests for pass and fail (DNS answers private / Cloudflare / none; health down; stale hub; count mismatch; no phone; no offline scan); no-scrollbar spec covers the new page; `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` pass. Leave phone and desktop screenshots of the page under `plans/m12-hub-setup/screenshots/`.

## Summary for reviewer

(fill in when done)

## Fix requests

(none)

## Blocker
