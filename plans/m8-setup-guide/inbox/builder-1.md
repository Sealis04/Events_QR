# builder-1 — m8-setup-guide

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

`docs/setup-guide.md` (new), small corrections to `docs/deploy-vm.md`, `docs/deploy-hub.md`, `docs/runbook.md` and `.env.demo` where the guide exposes a gap, plus the two app changes in part A (scanner "Set up again", hub "Pull tickets now") and their tests. Do not change other app code; list anything else under Follow-ups in `plans/m8-setup-guide/INBOX.md`.

## Shared files

(none)

## Tasks

M8 from `plans/offline-qr-ticketing/plan.md` (read its M8 section: it is the spec for the guide), plus two small app fixes the user asked for. Describe the app as built on `main`; where the plan, spec and app differ, the app wins for the guide's wording.

### A. App fixes (do these first)

1. **"Set up again" wipes the phone (user decision 2026-10-23, follow-up to Sealis04/Events_QR#12).** In `/scan`, "Set up again" first tries to upload the outbox (hub, then VM). If anything is still queued, show how many scans would be lost and require a supervisor PIN to continue. Then wipe the device token, event keys, ticket table, staff hashes, outbox and session, and show the setup screen. Tests (unit with the in-memory/fake-IndexedDB store, plus a Playwright check that no ticket or key record remains in IndexedDB afterwards). Update the runbook's wipe step to mention it next to Revoke. Reference #12 in the commit.
2. **"Pull tickets now" on the hub dashboard (user decision 2026-10-23).** A supervisor/admin button on the hub dashboard that triggers an immediate VM → hub pull (tickets, staff, settings) and shows the result (pulled N changes, or "VM not reachable" with the last successful pull time). Rate-limit to once per 10 s. Implement it so the app process signals the sync worker (e.g. a flag row in `hub_state` the worker polls every second, or a local endpoint on the worker) without giving the web process VM credentials it does not already have. Tests for the trigger, the rate limit and the unreachable case. Replace the runbook's `docker compose ... restart worker` "forced pull" step with this button (keep the restart as a fallback line).

### B. Setup guide (M8)

3. **`docs/setup-guide.md`** for an IT person doing the first install from zero, following the plan's M8 bullets in order: prerequisites checklist; VM (Docker, clone, every `.env` variable explained with which are secrets, key generation, `docker compose -f docker/compose.vm.yml up -d`, migrations, first admin with an 8+ digit PIN, backups of DB and key file); Nginx Proxy Manager proxy host + SSL + port forward + Cloudflare record; Gmail service account with domain-wide delegation, scope, key file, sender, test email; hub (OS, Docker, `docker/compose.hub.yml`, DNS-only `hub.<domain>`, DNS-01 certificate and renewal, router/dnsmasq override, `scripts/hub-enroll.ts`, standby hub); first event end to end (event, gates, ticket types, staff assignment, test ticket, print hub setup codes, set up a phone, scan, dashboard, then pull the internet cable and scan again); upgrading to a new version (pull, migrations, rebuild, order of VM then hub, phone re-setup when the store format changes) and rotating keys (`scripts/gen-signing-key.ts --rotate`, event key master).
   - Every step ends with **Check:** (exact command or what you should see) and **If it fails:** (one line).
   - A troubleshooting table at the end: phones don't trust the hub certificate; `hub.<domain>` doesn't resolve offline; Cloudflare proxy (orange cloud) left on for the hub record; Gmail 403 / delegation not set; Gmail daily limit; migrations fail; phone stuck on Cloud-only; clock drift between phone, hub and VM; worker can't write the key file; 6-digit supervisor PIN refused.
   - Link to `docs/deploy-vm.md`, `docs/deploy-hub.md`, `docs/runbook.md` and `docs/field-test.md` for depth; the guide must still be followable on its own.
4. **Verify the guide in this sandbox** as far as possible: run every command that does not need real Cloudflare, Let's Encrypt, Gmail, a router or Docker Hub, on a clean checkout (`git clone` into a scratch dir, follow the guide literally). Record in your summary which steps you ran, which you could not and why. Try `docker compose -f docker/compose.vm.yml config` and, if a Docker daemon is available, `docker compose build`; if not, say so. Fix the guide (or `.env.demo`/deploy docs) wherever following it literally fails.

## Done when

The plan's M8 "Done when" holds, A1 and A2 are implemented and tested, and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
