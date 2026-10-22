# builder-1 — m7-rehearsal

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`docs/runbook.md`, `docs/field-test.md`, `scripts/rehearsal-seed.ts` and its test, small fixes to `docs/deploy-vm.md` / `docs/deploy-hub.md` where the runbook exposes a gap, and the dashboard print page only if needed for the ticket sheet (task 3). Do not change other app code; list anything else you find under Follow-ups in `INBOX.md` instead.

## Shared files

(none)

## Tasks

The plan's "Wrap-up — Dress rehearsal" (called M7 in `INBOX.md`). Spec sections in `docs/spec.md`: "Admin dashboard and event-day operations" (runbook, failure modes), "Stack, milestones and testing" (field test). The plan wins over the spec, and the app as built (M1–M6 on `main`) wins over both: describe what the screens and commands actually do now. Write for event staff and a supervisor, not developers: plain words, short steps, what to tap and what you should see.

1. **`docs/runbook.md`** — the event-day runbook as a printable checklist (`- [ ]`), by time:
   - **T−7 days:** hub connected to the internet (certificate renewal), staff assigned to the event, supervisor/admin PINs are 8+ digits, ticket types and gates final (gate order fixed once tickets exist), test email received.
   - **T−24 h:** set up every phone with its setup QR (gate + role), check each ready screen, print a batch of hub setup codes for spare phones, load the latest tickets on the hub and the standby hub, test-scan one ticket of each type at each gate (entry and exit), PIN login on each phone.
   - **T−2 h:** power hub, router, access points; every phone shows Hub (green); forced ticket pull; dashboard opens on the hub.
   - **T−15 min:** final pull; decide on door sales (they show AMBER until the next sync if the hub is offline).
   - **Doors:** supervisor watches the device panel; any phone Offline or unseen for more than 2 min gets fixed or moved; how to do a manual admit; how to handle AMBER, wrong gate, too early, already used, cancelled.
   - **During:** what each failure in the spec's failure-modes table looks like on screen and what to do (internet down, hub down → standby hub, access point down, phone dies, code won't scan, lost/stolen phone → Revoke and rotate).
   - **After doors / after the event:** let the hub upload all scans (pill and hub health show 0 pending), review the conflict feed, wipe phones, power down, note that data retention runs automatically.
   - A one-page **quick card** per role (door staff, supervisor) at the end, short enough to print and tape to a gate.
2. **`docs/field-test.md`** — the field test from the spec: 50 printed tickets of mixed types (single, limited re-entry, unlimited, gate-restricted, time-slotted, one cancelled, one transferred), scanned from cracked phones, dim screens, paper, in glare, at real gates with real staff. Include: setup steps, a results table to fill in (scenario, expected screen, actual, time to result, pass/fail), the offline drills (pull the hub's uplink; switch off the hub; switch off one access point; airplane-mode one phone and reconnect), a deliberate shared-screenshot test that must show a conflict, and the exit criteria for going live (e.g. every scenario passes, frame-to-result under 300 ms on the target phones, outbox drains to 0, conflicts flagged).
3. **`scripts/rehearsal-seed.ts`** — creates a "Dress rehearsal" event on a dev or staging VM with two gates, the ticket types the field test needs, the 50 tickets in the right mix (incl. one cancelled and one transferred), and writes a printable sheet (HTML or PDF, one QR per ticket with the caption: name, type, scenario, last 6 hex) to a path you pass. Idempotent (re-running reuses the event). Refuses to run unless `--yes` is passed and the target is not the production URL configured in env. A test that runs it against the test database and checks the mix.
4. Cross-check: every screen, button and command named in the runbook exists in the app as built (route names, button labels, scripts). Fix wording to match.

## Done when

The runbook and field test cover every item above, every named button/command matches the app, the seed script works and is tested, and `bun run lint`, `bunx tsc --noEmit` and `bun run test` pass.

## Summary for reviewer

Files changed: `docs/runbook.md` (new), `docs/field-test.md` (new), `scripts/rehearsal-seed.ts` (new), `apps/web/test/rehearsal-seed.test.ts` (new), `docs/deploy-hub.md` (Offline pill row was stale: phones now decide alone offline; link to the runbook).
What was done: (1) Runbook as `- [ ]` checklist T-7 d to after the event, pill and screen tables, failure table, lost-phone and standby steps, two quick cards. (2) Field test: setup, the 50-ticket mix, 25-row results table, five offline drills plus lost-phone drill, shared-screenshot test, go-live criteria. (3) Seed script creates "Dress rehearsal" (Gate A/B, 5 types, 50 tickets incl. cancelled and transfer old/new) and writes an HTML sheet; `--yes` required; refuses when target (`--target-url` or `PUBLIC_URL`) equals `PRODUCTION_URL`; needs an existing admin; idempotent (fixed idempotency keys, slots as fixed offsets from doors-open). (4) Labels in the docs were checked against the source of the scanner and dashboard tabs.
What to check: Not walked in a browser, only against source and the seed run on the dev DB (sheet had 50 figures and was byte-identical on re-run). The "forced pull" in the docs is `docker compose ... restart worker` (the worker pulls at start); there is no dedicated command. The script selects whole tables and filters in JS because `drizzle-orm` is not resolvable from `scripts/`. `slot-early` tickets stay too early only for about 5 days after the event is created. Field-test drill claims (e.g. conflict on two offline gates) follow the spec and hub sync rules but were not run on hardware.
Conflicts resolved: (none)

## Fix requests

1. Issue #11, `docs/runbook.md` T-24 h: the dashboard never shows the `DEV1:` text, only a QR image. Reword the "Type the code instead / paste" fallback so staff are not told to paste text they cannot get (see the issue for options).
2. Issue #12, `docs/runbook.md` line 165 and `docs/deploy-hub.md` line 165: "Set up again" does not wipe the phone. Use **Revoke** (VM Devices tab) as the wipe, plus clearing the browser's site data as the manual fallback.
3. Issue #12, minor: name the amber screen's button **Supervisor override**; note an Entry and exit phone's header reads `Gate A · Entry / Exit`.

Everything else I walked matched (see INBOX.md `## reviewer`). Docs only; do not change app code. Then re-run lint, tsc, tests, push, set DONE.

## Blocker

(none)
