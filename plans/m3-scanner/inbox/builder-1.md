# builder-1 — m3-scanner

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M3 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M3 from `plans/offline-qr-ticketing/plan.md`: the online scanner PWA, plus two decisions the user made after M2. Spec sections in `docs/spec.md`: "Scanner app" (device setup, local state, validation algorithm, result screen, other behaviour), "Venue hub and sync protocol" (the claim SQL), "APIs" (hub API, which the VM mirrors for now). The plan wins over the spec.

### A. User decisions from the M2 review (do these first)

1. **Cancelling frees the place.** `cancelTicket` in `apps/web/src/server/tickets.ts` must decrement `ticket_types.issued` by 1 in the same transaction as the status change, only when the ticket actually moves to `cancelled` (no double decrement on a repeat cancel). The old QR stays rejected as cancelled. Transfer stays net-zero, as now. Tests: cancel frees a place on a sold-out type so one more ticket can be generated; repeat cancel does not free a second place; concurrent cancels of the same ticket free exactly one place.
2. **Old signing secrets are kept only until their events end.** Add an automatic cleanup (in `apps/worker`, run on start and hourly): for every non-current key generation, delete its secret from the key file once no event with that `sign_key_id` has `ends_at` in the future. The public key stays. Re-send of a ticket whose key secret is gone returns a clear 409 (`signing_key_retired`) instead of a 500. Keep `scripts/gen-signing-key.ts --retire` working. Tests for both paths; write the key file atomically (temp file + rename).

### B. Online scanner (M3)

3. **VM endpoints the scanner needs** (the hub API mirrored on the VM, device bearer token auth): `POST /api/claim` and `POST /api/exit` doing the spec's atomic claim/exit on MariaDB (conditional `UPDATE … WHERE status='valid' AND inside=0`, rows affected decides; reuse `decideClaim`/`decideExit` from core for the response), idempotent on `scan_id`; `GET /api/sync?cursor=` for devices (ticket changes incl. `admits_used`/`inside`, device setting changes, server time); `GET /api/health`. Same request/response shapes as the core hub zod schemas, so M4 can point the scanner at the hub unchanged.
4. **Scanner PWA** under `apps/web/src/app/scan/...`: web app manifest, service worker that caches the scanner routes and assets so the app reloads with the network off; install prompt.
5. **Enrolment flow:** "Set up for event" scans a `DEV1:` setup QR, calls `/api/devices/enroll` to exchange the code, stores the device token, event key bundle, gate and role in IndexedDB, runs a full ticket sync, then shows the ready screen ("Gate A · Entry"). Request `navigator.storage.persist()`. Only then accept `EVT1:` codes. Staff PIN login on the device before scanning.
6. **Scanning:** camera via `BarcodeDetector` where available, ZXing-WASM fallback otherwise (bundle it, no CDN, so it works offline later). Run the spec's validation order client-side with core's `verifyToken` + `checkEntry` (incl. the type's early-entry minutes from sync), then call `/api/claim` or `/api/exit`.
7. **Result screens** exactly as the spec table: green admitted (name, type, "Entry 2 of 3"), blue exit, grey "No re-entry on this ticket", red used/inside (first scan's gate, time, device), red invalid/wrong event/wrong gate/outside slot (reason + right gate or slot times), amber "Valid signature, not in list" with supervisor PIN override logged as `override`. Sounds/vibration, auto-dismiss times from the spec. 3 s debounce of the same code. Connection pill (Hub / Cloud-only / Offline + outbox count; in M3 only Cloud-only and Offline apply). Entry/Exit toggle when the device role is both. Manual search by name or last 6 hex.
8. **Tests.** Unit tests for the client validation pipeline (every result state). Route tests for `/api/claim` and `/api/exit` against MariaDB: single, unlimited and limited-N tickets; exit required before re-entry; cancelled; idempotent replay of a scan_id; 20 parallel claims of one single-entry ticket give exactly 1 admit. A Playwright test that enrols a device with a setup QR, scans a ticket (feed the code through a test hook instead of the camera) and sees the green screen, then the red "already used" on a rescan. A Playwright check that the scanner route loads with the network offline after first load.

## Done when

All of "Done when" for M3 in the plan holds (frame-to-result under 300 ms on a mid-range phone is checked in the field test; here, measure the decode + verify pipeline time in a test and report it), the decisions in A are implemented and tested, and `bun run lint`, `bunx tsc --noEmit` and `bun run test` pass.

## Summary for reviewer

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
