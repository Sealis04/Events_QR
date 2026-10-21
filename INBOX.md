# INBOX

Coordination file for the Events_QR build. Plan: `plans/offline-qr-ticketing/plan.md`. Spec: https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7

## Current

- **Milestone:** M1 — Core tokens and shared contracts
- **Owner:** Builder 1
- **Branch:** `build/m1-core` (create it from `main`)
- **State:** assigned

States: `assigned` → `in progress` → `ready for review` → `changes requested` | `merged`.

## How the loop works

**Builder 1**
1. Read the current milestone's section in the plan and the spec.
2. Set State to `in progress`, build on the milestone branch, keep lint, typecheck and tests green.
3. When it meets "Done when": push the branch, set State to `ready for review`, add a short entry under Log, push this file to `main`, then fire the Reviewer Routine (`REVIEWER_TRIGGER_ID`).
4. If State is `changes requested`, work through the Review notes on the same branch, then repeat step 3.

**Reviewer**
1. Review the milestone branch against the plan's "Done when" and the spec. Run the tests.
2. If it needs changes: set State to `changes requested`, write the notes under Review notes, push this file to `main`, and fire Builder 1 (`BUILDER1_TRIGGER_ID`).
3. If it passes: merge the branch into `main`, add a Log entry, then set Current to the next milestone (State `assigned`, new branch name), clear Review notes, push, and fire Builder 1.
4. After the Wrap-up merges, set State to `done` and do not fire anyone.

Trigger IDs live in env vars. Use them directly; never print or commit them.

## Queue

1. M1 — Core tokens and shared contracts — `build/m1-core`
2. M2 — Cloud issuance — `build/m2-cloud`
3. M3 — Online scanner — `build/m3-scanner`
4. M4 — Venue hub and sync — `build/m4-hub`
5. M5 — Offline mode — `build/m5-offline`
6. M6 — Dashboard — `build/m6-dashboard`
7. Wrap-up — Dress rehearsal docs — `build/m7-rehearsal`

## Review notes

(none)

## Follow-ups

(none)

## Log

- 2026-10-21 — Planner: draft plan written; stack set (Next.js, MariaDB, self-hosted VM, venue hub, Gmail API); awaiting approval.
- 2026-10-21 — Planner: plan approved by the user; M1 assigned to Builder 1.
