# builder-1 — m11-ui-refresh

**Status:** DONE
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything under `apps/web/src/app/` (pages, `_components/`, `dashboard.css`, `scan/`), `apps/web/src/scanner/` where the login and result screens need it, the API routes the new UI needs (tickets list paging/sort/CSV export, revoke), their tests, `apps/web/e2e/`, and `docs/setup-guide.md` section 4.6 plus its troubleshooting rows, `docs/runbook.md` / `docs/deploy-hub.md` lines that describe changed UI. No schema change is expected; if you need one, add a migration and say why in your summary. List anything else under Follow-ups in `plans/m11-ui-refresh/INBOX.md`.

## Shared files

(none)

## Tasks

M11 of `plans/offline-qr-ticketing/plan.md` (read it and "Decisions after the test copy"). The target screens are in `plans/m11-ui-refresh/mockups/` (read its README first): match their layout, wording, sizes and colours. Sample names and numbers in them are not real data. Where a mockup shows something the API cannot answer yet, add the smallest server change that makes it real (listed below); do not fake numbers.

### A. Foundations (do first)

1. **Design tokens and base components** in `dashboard.css` (or a new shared stylesheet) from the mockups README: font (Inter via `next/font/google` if it builds offline-safe, else the system stack), colours, radii, 44 px inputs and buttons, chips, cards, status tags, tab strip, ⋯ menus, dialogs, sticky action bar. Replace `window.confirm` / `window.prompt` in the dashboard with a small accessible dialog component (focus trap, Escape closes, real `<button>`s).
2. **Phones have no scrollbars (user decision).** At widths 360–430 px: nothing overflows sideways on any page; scanner screens fit `100dvh` with no scrolling; any element that must scroll on phones (tab strip, long lists) hides its scrollbar (`scrollbar-width: none` and `::-webkit-scrollbar { display: none }`) while touch scrolling still works. Add a Playwright spec that visits every dashboard page and every scanner state at 390×844 and 360×740 and fails if `document.documentElement.scrollWidth > clientWidth` or any element has a visible scrollbar (`offsetWidth - clientWidth > 0` or `offsetHeight - clientHeight > 0` on a scrollable element).

### B. Behaviour changes

3. **Phone login lasts (user decision: until sign-out or the end of the event day).** Move the staff session from `sessionStorage` (`scanner.staff` in `ScannerApp.tsx`) into the phone's encrypted IndexedDB store (same protection as the other secrets, cleared by `store.wipe()`). It ends on: Sign out / Switch staff member, the next 05:00 event-local time after login (so late-night shifts are not cut at midnight), event end, revoke, "Set up again". It must survive a reload, closing and reopening the app, and a browser restart, online and offline. No idle timeout, no biometrics. Unit tests for the expiry rule (time zone, DST-free, crossing midnight) and an e2e test (log in, reload, close the context and reopen with the same storage, still logged in; after the cut-off, asked again).
4. **Revoke (user decision).** Devices tab: one "Revoke…" action in the device's ⋯ menu. The dialog (see `Devices.dc.html`) explains what happens, says how many scans are waiting to upload, and has a "This phone was lost or stolen" checkbox; ticking it sends `rotate: true` and the dialog lists, before confirming, the people who will have to choose a new PIN (add a dry-run/preview to the revoke API, or a GET of the affected staff). The result message names them. Remove the separate "Revoke and rotate" button. Tests.

### C. Gate phone (`/scan`) — `ScanReady`, `ScanGreen`, `ScanRed`, `ScanMenu`

5. Header: event name, gate (big), staff member and device label, connection pill (Hub / VM only / Offline with the existing states), ⋯ menu button. Entry/Exit segmented toggle (52 px). Camera area with an aiming square. A line with this phone's counts today ("Today: N in · M out", from the phone's own scan log, works offline; label it so it is clear it is this phone) and "N waiting to upload". One full-width "Find a ticket by name" (manual search).
6. ⋯ menu as a bottom sheet: Switch staff member (sign out, keep the device), Camera help (per-browser steps for iOS Safari and Android Chrome plus a "Try camera again" button), Sign out, and "Set up this phone again" as a red confirm box that says what gets erased (keep the existing supervisor-PIN step when scans are queued). Set up again is no longer on the login screen's main buttons; put it behind a small link there with the same confirm.
7. Results: full-screen colour with a large icon and a word headline: ADMITTED (green, with "Entry k of n" or "Exit"), and for refusals ALREADY USED, WRONG GATE, NOT YET / TOO LATE (slot), CANCELLED, WRONG EVENT, NOT A TICKET, FORGED (red; exit-side equivalents). Under it: holder and type when known; for "already used" when/where/which device label; one plain line of what to do; a 64 px "Next scan" button on red screens. Green auto-continues as now with a visible countdown bar and tap-to-skip. Never show raw device ids.
8. Camera blocked: the same Camera help content inline with "Try camera again".

### D. Dashboard

9. **Events list** (`Events.dc.html`): cards with status (Live, In N days, Ended, Setup not finished = no ticket types), dates, venue, a progress bar (inside now of capacity for live events, issued of capacity otherwise) and gate/phone counts; filter pills Upcoming and live / Ended / All; "+ New event" button. Extend the events list API with the counts it needs.
10. **New event and Setup tab** (`Main.dc.html`, `Phone.dc.html`): numbered cards; time-zone `<select>` (IANA list, default the server zone, shown with UTC offset); doors open / ends; gates as tags with drag to reorder (plus keyboard: move up/down buttons for accessibility), ✕ to remove, inline "Add gate" input (Enter adds); keep the existing rules (max 16, order locked once tickets exist: show the lock on Setup). Ticket types as summary cards; one opens for editing: Name, Places (blank = no limit), "How many times can they get in?" Once / Up to a number (2–63) / Any number, "Which gates?" chips with All gates, "When can they come in?" rows of day select + from/until clock times (convert to the stored minutes-from-first-day), "Let them in 15 minutes early" checkbox (keep the 15–30 setting reachable if it exists today), and the generated preview sentence. Presets: General admission, VIP, Day pass, Blank. Sticky bottom bar with totals and Create event / Save. Setup saves all changes at once with inline errors next to the field.
11. **Event page shell:** event name as `<h1>` with status tag, meta line, one-line tab strip (scrolls without a scrollbar on phones) with a count badge on Conflicts. Tab "QR generator" is renamed "Issue tickets"; on it, move the entry-rule override under an "Advanced" disclosure and make Print/PDF a real button.
12. **Tickets** (`Tickets.dc.html`, `TicketsPhone.dc.html`): search (name, email, phone, ticket code) with type and status filters; sortable columns; server-side pagination 50 per page (must stay fast at 5,000 tickets); status tags (Not yet in, Inside, Left, Cancelled); ⋯ row menu: View ticket and QR, Resend email (disabled with a visible reason), Transfer… (dialog form, not prompts), Cancel ticket… (danger, confirm dialog). Export CSV (admin/supervisor; same filters; names and emails only for roles that may see them today). Phone layout as cards with "Show more".
13. **Live stats** (`Live.dc.html`): tiles (Inside now of capacity with bar, Entered today with left count, Scans per minute with busiest so far, Needs a look = open conflicts linking to the tab); by gate and by ticket type with capacity %; last-hour per-minute bars that read correctly at zero ("No scans yet"); "updated N s ago" and a warning when polling fails for 30 s; on the hub, a banner when the hub has no internet.
14. **Devices** (`Devices.dc.html`): columns Phone, Gate, Status, Last scan (HH:MM), Battery, Waiting to upload, ⋯; "Quiet" shown as "Quiet · no contact for N min" with a tooltip; "+ Set up a phone" button opens the existing setup-code flow.
15. **Smaller polish:** Attendees & overrides empty state without bare table headers; login page with the product name, a numeric keypad for PINs (`inputmode="numeric"`, `autocomplete="current-password"`) and clearer errors; print page shows event name, date, venue and allowed gates on each ticket and fits several tickets per A4 page; remove the duplicate "Events" heading; times without seconds everywhere.

### E. Hub DNS guide

16. Rewrite `docs/setup-guide.md` 4.6 so it works with any router: (a) give the hub a fixed address (DHCP reservation; TP-Link Archer example: Advanced → Network → DHCP Server → Address Reservation; generic wording for others), (b) start the hub's `dns` service, (c) set the router's DHCP Primary DNS to the hub's address (TP-Link Archer: Advanced → Network → DHCP Server → Primary DNS; leave Secondary empty, and say why), (d) on Ubuntu, free port 53 first (`systemd-resolved`'s stub listener: `DNSStubListener=no` in `/etc/systemd/resolved.conf`, restart, point `/etc/resolv.conf` at a real resolver) or bind dnsmasq to the LAN address only (add `HUB_LAN_IP` binding in `docker/compose.hub.yml` if needed and test `docker compose config`), (e) what happens when the hub is off (phones lose name lookups on the venue Wi-Fi; scanning falls back to the VM only if the internet and another DNS path work; keep the hub on a UPS). Keep the Check / If it fails lines; add troubleshooting rows for "port 53 already in use" and "phones still get the router as DNS" (reconnect Wi-Fi to renew the lease). Keep the router-override option as the alternative for routers that support it (OpenWrt, pfSense/OPNsense, UniFi, Omada).

## Done when

The plan's M11 "Done when" holds: screens match the mockups; the no-scrollbar spec passes at 390×844 and 360×740 on every page and scanner state; phone login survives reload and browser restart and ends at the cut-off; revoke works with and without the lost/stolen box; existing e2e flows still pass with updated selectors; `bun run lint`, `bunx tsc --noEmit`, `bun run test`, `bun run test:e2e` pass. Put before/after screenshots (desktop 1280×800 and phone 390×844) of each mockup screen under `plans/m11-ui-refresh/screenshots/` for the reviewer.

## Summary for reviewer

(fill in when done)

## Fix requests

(none)

## Blocker
