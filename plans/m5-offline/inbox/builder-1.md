# builder-1 — m5-offline

**Status:** DONE
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M5 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M5 from `plans/offline-qr-ticketing/plan.md`: offline mode, plus one security fix and one user decision. Spec sections in `docs/spec.md`: "Scanner app" (local state, validation algorithm offline branch), "Venue hub and sync protocol" (conflict handling, reducing offline exposure), "Security" (keys on devices, lost scanner). The plan wins over the spec.

Background: today a phone tries the hub (800 ms), then the VM. In M5, when **neither** answers, the phone decides alone from its local ticket list and queues the scan; it uploads later.

### A. Fix and decision (do these first)

1. **Sealis04/Events_QR#5 (reviewer finding):** `POST /api/sync/scans` on the VM must accept only hub tokens (`devices.kind = 'hub'`), and the VM must check that every uploaded scan's `device_id` belongs to that hub's event (a phone enrolled at that hub, or the hub itself). Phones upload their own offline scans to the hub (`POST /api/scans`) or, if they enrolled at / fall back to the VM, through a phone-scoped VM endpoint that only accepts scans whose `device_id` is the calling phone. Reject unknown `result` values. Tests for each rejection. Reference #5 in the commit message.
2. **Hub setup codes last all event (user decision 2026-10-22).** A supervisor can create a batch of single-use phone setup codes marked for the hub (e.g. 10), valid until the event's `ends_at` instead of 10 minutes. The hub caches them (hashed) so phones can enrol at the hub with no internet. Each code still works once; using it at the hub marks it used on the VM after the next sync, and a code used on one side is rejected on the other. Normal on-screen setup QRs keep the 10-minute expiry. Show the batch as printable setup QRs on the existing admin page.

### B. Offline mode (M5)

3. **Local ticket table** in IndexedDB, **encrypted at rest** (AES-GCM with a key derived from the device token / kept non-extractable in WebCrypto), holding the fields the spec lists plus `admits_used` and `inside`. Kept current by the 10 s device pull, including newly used ids from the hub.
4. **Offline decision.** When the hub and the VM both fail (hub 800 ms, then VM timeout), run the spec's offline branch with the shared `decideClaim`/`decideExit` from core: reject if `inside`, reject if `admits_used >= limit`, otherwise admit, update local state and push the scan to the outbox with `offline = true`. Orange OFFLINE banner on the result screen. Retry the hub on every scan.
5. **Persistent outbox.** Survives reloads and phone restarts (IndexedDB); uploaded to the hub first, else the VM, idempotent on `scan_id`; acknowledged scans removed. The pill shows the outbox count.
6. **Offline staff login.** Staff can log in on the phone with no network: cache an argon2id/PBKDF2 verifier of each staff PIN pulled during sync (never the PIN), plus role, so a supervisor override also works offline. Lock out after repeated wrong PINs.
7. **Offline exposure controls** from the spec: offline device beeps every 60 s and shows the orange banner; optional per-event setting "offline devices admit only tickets allowed at this gate" enforced from the signed `gate_mask`.
8. **Conflicts.** When offline scans reach the hub/VM for a ticket already admitted elsewhere, keep both rows, flag the later one by `scanned_at` as `conflict`, and expose conflicts in a simple list endpoint for M6's conflict feed. A ticket cancelled on the VM while a phone was offline stays admitted if it was admitted before the cancellation synced, and is flagged.
9. **Device revocation and wipe.** A revoked device wipes its keys, ticket table and outbox at its next sync (after uploading the outbox if it can); after the event ends, devices wipe event keys and ticket lists.

### C. Tests

10. **Chaos test** (the plan's M5 "done when"): a simulation of 5,000 scans across ~20 phones with random hub and access-point cuts (phones going offline and back), then reconcile. Assert: every scan reaches the VM exactly once; final `admits_used`/`inside` match a replay of all scans; every double admission caused by offline phones is flagged as a conflict and none is flagged falsely.
11. Unit tests for the offline pipeline (every result state offline), outbox persistence across reload, encrypted store round-trip, offline PIN login and lockout, #5 rejections, long-lived hub codes (single use across hub and VM).
12. Playwright: enrol, go fully offline (block hub and VM), admit with the OFFLINE banner, rescan shows "Already inside (offline)", reload the page offline and the outbox count persists, restore network and the outbox drains to 0 with the scan visible on the VM. Offline staff login works.

## Done when

All of "Done when" for M5 in the plan holds (the chaos test reconciles and every conflict is flagged), A1 and A2 are done and tested, and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

**Files changed:**
- Core: `packages/core/src/rules/replay.ts` (new, shared replay/conflict rule), `rules/index.ts`, `api/common.ts` (`cancelled_at` on syncTicket), `api/hub.ts` (sync response gains `staff`, `settings`), `api/cloud.ts` (batch setup codes, `offline_gate_only`, conflicts feed schemas), `db/mysql.ts` + `db/sqlite.ts` (`tickets.cancelled_at`), migrations `drizzle/mysql/0003_*`, `drizzle/sqlite/0002_*`.
- VM/hub server: `server/sync.ts` (#5 fix, `uploadPhoneScans`, `ingestScans`, sync response), `server/devices.ts` (batch hub codes), `server/events.ts`, `server/tickets.ts` (`cancelled_at`), `server/stats.ts` (`listConflicts`), `server/settings.ts` (new), `hub/recompute.ts`, `hub/sync.ts`, `hub/vmsync.ts`; routes `api/sync/scans`, `api/scans` (now VM + hub), `api/events/[id]/conflicts` (new); admin page `app/events/[id]/page.tsx` (printable hub setup QRs).
- Phone: `scanner/secureBox.ts`, `idbStore.ts` (rewritten, AES-GCM at rest, DB v2), `memoryStore.ts`, `types.ts`, `client.ts`, `routes.ts`, `outbox.ts` (new), `cycle.ts` (new), `sync.ts`, `staff.ts`, `pipeline.ts`, `result.ts`, `app/scan/ScannerApp.tsx`.
- Deps: `hash-wasm` (argon2id verify in the browser), `fake-indexeddb` (dev).
- Tests: new `devices-sync` #5 block, `hub-codes`, `scanner-offline`, `scanner-idb`, `scanner-staff-offline`, `chaos`, fixtures; updated `scanner-pipeline`, `scanner-result`, `hub-mode`; e2e `offline.spec.ts`, `scanner.spec.ts` (old "fails closed" case now admits offline). `docs/deploy-hub.md`.

**What was done:**
- A1 (#5): `POST /api/sync/scans` is hub-token only and 403s the whole batch if any `device_id` is not a device of the hub's event; phones use `POST /api/scans` (VM: only own `device_id`, scanner tokens only; hub: unchanged). Unknown `result` values 400 by schema. Tests for each rejection.
- A2: `POST /api/devices/enroll` with `for_hub:true,count:N` makes single-use codes expiring at `ends_at` (no schema change: the hub already caches unused unexpired codes; used-on-one-side/other-side via existing sync). Printable QR grid on the event page.
- B3-B5: encrypted IndexedDB (non-extractable AES-GCM key, per-record AAD), persistent outbox (hub first, else VM, idempotent, ack-removal), pill count; offline branch uses core `decideClaim`/`decideExit`; orange OFFLINE banner; supervisor override works offline from the signed QR.
- B6: sync delivers staff argon2id hashes; phone verifies with hash-wasm; 5 wrong PINs lock 60 s doubling to 15 min, persisted in the store.
- B7: 60 s offline beep + banner; `offline_gate_only` event setting (PATCH event) delivered in sync.
- B8: conflicts already flagged by recompute; now shared `replayScans`. Cancelled-while-offline: new `tickets.cancelled_at`; an offline admit scanned at/after it stays admitted and is flagged. `GET /api/events/{id}/conflicts` (supervisor).
- B9: `syncCycle` drains outbox then syncs; revoked → full wipe; 2 h after `ends_at` → keys and tickets wiped (outbox + token kept until uploaded, then full wipe).
- Chaos test (seeded, `CHAOS_SEED`): 5,000 scan attempts (about 4,280 recorded, 630 decided offline), 20 phones, random hub/AP/uplink cuts; asserts exactly-once on VM and hub, final state vs independent replay, conflict flags exact on both. Mutation-checked.

**What to check:**
- Schema change (`cancelled_at`, nullable) was needed although the inbox listed none; migrations generated with drizzle-kit (no db:dev).
- `offline_gate_only` interpretation: when on, offline admits require an explicit gate in the signed mask (mask 0 = refused offline; supervisor override still works). Online and exits unaffected.
- IndexedDB v2 upgrade drops v1 data (phones must re-enrol); ticket ids stay in clear as record keys. The CryptoKey sits in IDB beside the data: protects copies/backups, not an attacker with live script access.
- Staff PIN hashes now go to every phone (needed for offline login; brute-forceable at 6 digits if a phone is stolen: revocation/lockout only help online).
- Revoked device cannot upload its last scans (server 401s revoked tokens); only scans made since the last 10 s cycle are lost.
- Scans for tickets the server does not know are left unacknowledged (stay queued).
- Offline claim retry costs hub 800 ms + VM 1.2 s per scan while offline (VM timeout shortened from 4 s once the pill is offline).
- `hub` has no conflicts endpoint (no staff session there); left to M6.

**Conflicts resolved:** (none)

## Fix requests

(none)

## Blocker

(none)
