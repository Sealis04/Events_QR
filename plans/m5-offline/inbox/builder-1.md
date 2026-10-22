# builder-1 — m5-offline

**Status:** PENDING
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

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
