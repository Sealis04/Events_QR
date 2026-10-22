# builder-1 — m3-scanner

**Status:** DONE
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

**Files changed:**

- A1 cancel frees a place: `apps/web/src/server/tickets.ts` (`cancelTicket` now a transaction with `issued - 1`; `resendTicket` checks the key); tests in `apps/web/test/issuance.test.ts` (3 new).
- A2 key retirement: `apps/web/src/server/signing.ts` (atomic temp-file + rename write, `listSigningKeys`, `Signer.canMint` re-reads the file), new `apps/worker/src/keyCleanup.ts` + wired into `apps/worker/src/main.ts` (on start, hourly), `apps/worker/src/emailQueue.ts` (`SigningKeyUnavailable` is a permanent failure), tests `apps/worker/test/keyCleanup.test.ts`, `apps/web/test/signing.test.ts`; `docker/compose.vm.yml` (worker's `/secrets` mount is now writable), `docs/deploy-vm.md`.
- B3 VM endpoints: new `apps/web/src/server/claim.ts`, routes `apps/web/src/app/api/{claim,exit,sync}/route.ts`, `syncForDevice` in `apps/web/src/server/sync.ts`, `keyBundle`/`loadTypes`/`scannerTypes` in `apps/web/src/server/events.ts`, `devices.ts`; test `apps/web/test/claim.test.ts` (14). `GET /api/health` already existed and already matches.
- core (allowed): `packages/core/src/api/common.ts` (`scannerTicketType`; `keyBundle.ticket_types`, default `[]`), `packages/core/src/api/hub.ts` (`claimRequest.override?`, `hubSyncResponse.ticket_types`). Core tests unchanged and green.
- B4-7 scanner: `apps/web/src/scanner/*` (types, idbStore, memoryStore, search, client, pipeline, sync/enrol, staff, decoder, result, feedback), `apps/web/src/app/scan/{layout,page,ScannerApp,Camera}.tsx`, `apps/web/public/scan-sw.js`, `apps/web/public/scan/{manifest.webmanifest,icon-192.png,icon-512.png}`, `apps/web/scripts/gen-scanner-icons.ts`, `apps/web/next.config.ts` (no-cache header for the worker), `docker/Dockerfile` (copies `public/`).
- B8 tests: `apps/web/test/scanner-{pipeline,result,decoder,enrol}.test.ts`; Playwright: `apps/web/playwright.config.ts`, `apps/web/e2e/{prepare.ts,constants.ts,scanner.spec.ts}`; scripts `test:e2e` in root and `apps/web` package.json; `zxing-wasm` dependency, `@playwright/test` dev dependency (`bun.lock`).
- Tooling: `eslint.config.js` (service-worker globals), `tsconfig.json` + `apps/web/tsconfig.json` (include `e2e`, `scripts`), `.gitignore` (Playwright output).

**What was done:**

- A1: cancelling decrements `ticket_types.issued` in the same transaction, only for the call that flips the status (row lock + status check). Tests: frees a place on a sold-out type, repeat cancel frees one, 10 concurrent cancels free one.
- A2: worker `cleanupSigningKeys` retires every non-current generation with no event whose `ends_at` is in the future (public key stays); runs on start and hourly. Re-send of a retired-key ticket returns 409 `signing_key_retired`; the email worker fails such queued mails permanently instead of retrying. Key file is written atomically. `--retire` still works.
- B3: `POST /api/claim`, `POST /api/exit`, `GET /api/sync` with device bearer auth. The claim is the conditional `UPDATE ... WHERE status='valid' AND inside=0` (rows affected decides), a scan row for every attempt, idempotent on `scan_id` (a replay returns the same verdict, nothing changes), `decideClaim`/`decideExit` build the responses. `override: true` (new optional field) records `override` and needs a supervisor `staff_id`.
- B4-7: `/scan` PWA: manifest, service worker (shell network-first with cached fallback; hashed build files + the bundled ZXing WASM cache-first; page hands the SW the files it loaded after the first visit), install prompt, `DEV1:` enrolment with full sync before the ready screen, `navigator.storage.persist()`, staff PIN login (session only), BarcodeDetector with bundled ZXing-WASM fallback, all result screens and sounds/vibration, 3 s debounce, connection pill, Entry/Exit toggle for role both, manual search by name or last hex.
- B8: 133 web tests (was 86 before this branch's additions: +3 cancel, +1 signing, +14 claim, 18 pipeline, 7 result, 3 decoder, 5 enrol), 18 worker tests, core 58; 4 Playwright tests pass (`bun run test:e2e`, builds the app, uses DB `<DB_NAME>_test_e2e`).
- Timing (Node, this sandbox): verify + entry checks median 0.4 ms (p95 1.9 ms); ZXing-WASM decode of a 400 px EVT1 QR + verify + checks median 4.2 ms (max 35 ms). The 300 ms frame-to-result budget is for the phone and still needs the field test (the network call adds to it).

**What to check:**

- `bun run test:e2e` is separate from `bun run test` (needs Chromium and a ~80 s production build). In the sandbox it uses `/opt/pw-browsers/chromium-1194`. Run it from `apps/web` via the package script (plain `npx playwright` picked a different copy and failed). Consider adding it to CLAUDE.md's commands (I may not edit that file).
- `UPDATE ... SET` order: MariaDB assigns left to right and drizzle writes columns in schema order, so `status` sees the already-incremented `admits_used` (comment in `claim.ts`; the limited-ticket test pins it). M4's SQLite version assigns simultaneously, so the spec's `admits_used + 1 >= max` is right there.
- Deliberate choices where the spec was open: (1) unknown ticket + entry runs gate/slot checks first (red if they fail), amber only otherwise; (2) a single-entry ticket scanned again shows "Already used" (not "Already inside"); (3) `first_scan` in `/api/claim` is the ticket's most recent admission; (4) `rejected_cancelled` attempts are logged with scan result `rejected_invalid` (no new CHECK value/migration); (5) the device's own gate (not the body's `gate`) is stored on the scan; (6) manual search admits only with a supervisor PIN (recorded as `override`) and the signed gate/slot checks cannot run there; manual exit needs no PIN.
- `staff_id` in claim bodies is trusted after the device-side PIN login (as in the spec); an override only checks that the id belongs to a supervisor/admin. Staff login on the phone is sessionStorage-only, so it needs the network (offline PIN is M5).
- `/api/sync` returns only the calling device in `devices`; a revoked device gets 401 and wipes itself.
- Ticket `keyBundle` now carries `ticket_types` (early-entry minutes); `/api/sync` also returns them so edits reach phones. Setup QR URL is used for enrolment; the e2e builds it from the request origin.
- The worker now needs write access to the key file's folder (compose changed; secrets mount no longer `:ro` for the worker).
- Outbox is only a count (0) in M3; no offline queue yet.

**Conflicts resolved:** (none)

## Fix requests

(none)

## Blocker

(none)
