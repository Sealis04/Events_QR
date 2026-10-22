# builder-1 — m4-hub

**Status:** PENDING
**Mode:** sequential (only builder; builder-3 is NOT USED)

## Owned files

Everything in the repo except: `CLAUDE.md`, `docs/spec.md`, `plans/` (other than this file), `INBOX.md`. Changes to `packages/core` are allowed where M4 needs them (keep its tests green and list every change in your summary).

## Shared files

(none)

## Tasks

Milestone M4 from `plans/offline-qr-ticketing/plan.md`: the venue hub and sync. Spec sections in `docs/spec.md`: "Venue hub and sync protocol" (hardware, the claim SQL, sync loops, conflict handling), "Scanner app" (device setup via the hub), "APIs" (hub API), "Admin dashboard and event-day operations" (runbook, failure modes). Plan sections: M4 and "Hub HTTPS and DNS". The plan wins over the spec.

Background you need: the hub is a mini PC / Pi on the venue Wi-Fi. During the event it is the only authority for "used". It holds **no signing secret** (public keys and the event AES key only), so it can verify and claim tickets but never mint them. The VM keeps issuing tickets; the hub syncs with it whenever internet exists. Phones talk to the hub first; in M4 they fall back to the VM when the hub is unreachable (offline-alone mode is M5).

1. **Hub mode.** The same Next.js build with `APP_MODE=hub`, using SQLite (better-sqlite3, WAL, `busy_timeout`) through the M1 SQLite schema and migrations. In hub mode, issuance/admin routes that need the signing key or MariaDB are disabled (404/403); scanner-facing routes are served: `POST /api/enroll`, `POST /api/claim`, `POST /api/exit`, `GET /api/sync`, `POST /api/scans`, `GET /api/health`, plus staff PIN login for phones. Keep request/response shapes identical to the VM's so the scanner client is unchanged.
2. **Atomic claim/exit on SQLite.** The spec's `BEGIN IMMEDIATE` claim and exit SQL. Note SQLite assigns SET columns simultaneously (unlike MariaDB), so the spec's `admits_used + 1 >= max_admits` form is the correct one here. Idempotent on `scan_id`. Reuse `decideClaim`/`decideExit` for responses.
3. **Hub enrolment with the VM.** A way to bind a hub to one event: an admin/supervisor creates a hub setup code on the VM (new endpoint or a `role: hub` on the existing enrol flow) and `scripts/hub-enroll.ts <VM URL> <code>` stores the hub's credential, the event key bundle and public keys in the hub DB/secret file. The hub never receives the Ed25519 secret.
4. **Sync loops** (in `apps/worker` with `APP_MODE=hub`, or a hub process; your call, document it):
   - Ticket pull, VM to hub, every 30 s and on demand: `GET /api/sync/tickets` with the monotonic cursor; also ticket types, staff (name, role, PIN hash, for phone login at the hub), device setting changes, revocations.
   - Scan push, hub to VM, every 5 s when online, batches up to 500, idempotent; mark acked scans.
   - Enrolment codes: the hub keeps unused phone enrolment codes (hashed) pulled from the VM so phones can enrol with no internet. Phones enrolled at the hub must also become valid devices on the VM (push them up on the next sync) so the VM fallback accepts their token.
   - Device pull, hub to phone, every 10 s (`GET /api/sync` on the hub): ticket changes incl. `admits_used`/`inside` and newly used ids, device settings, hub time for clock sync.
   - Cursors are `(updated_at, id)` pairs; every write idempotent on its id; any loop safe to retry. Exponential backoff when the VM is unreachable; the hub keeps serving claims throughout.
5. **Conflicts.** Scans that reach the hub (or the VM) for a ticket already admitted elsewhere keep both rows; the later one by `scanned_at` gets `conflict = true`. Make the hub and VM agree after sync (the VM's M2 recompute already does this for uploaded scans; make sure hub-side state converges too).
6. **Scanner talks to the hub first.** The phone uses the hub URL from its `DEV1:` setup QR; if the hub does not answer within 800 ms it uses the VM for that scan and the pill shows Cloud-only; Hub (green) when the hub answers. Retry the hub on every scan. Enrolment tries the hub first, then the VM.
7. **Deploy.** `docker/compose.hub.yml` (app in hub mode + sync process, SQLite on a volume) and `docs/deploy-hub.md`: hardware (Pi 5 / mini PC with SSD, UPS, dedicated router + AP per gate), Cloudflare DNS-only record `hub.<domain>` to the hub's LAN IP, Let's Encrypt cert via Cloudflare DNS-01 (Nginx Proxy Manager on the hub or certbot-dns-cloudflare) with renewal, a local DNS override on the venue router or dnsmasq on the hub so `hub.<domain>` resolves with no internet, standby hub procedure, and that the hub needs internet at least every ~60 days for cert renewal. Never commit the Cloudflare token.
8. **Tests.**
   - Concurrency: 20 simulated devices claiming the same 100 tickets at once against the hub's SQLite gives exactly 100 admits (and every other attempt rejected).
   - Uplink cut: with the VM unreachable, the hub keeps admitting and exiting; when it comes back, all scans upload exactly once and the VM's counts match the hub's.
   - A ticket generated on the VM appears on the hub within one pull cycle and on a phone within one device-pull cycle; a cancellation does too and is then rejected at the gate.
   - Phone enrolment at the hub with no VM reachable, then that phone's token works against the VM after the next sync.
   - Exit / re-entry rules on the hub match the VM's (shared test table run against both backends).
   - Hub mode refuses issuance routes and never has a signing secret on disk.
   - Playwright: scanner enrolled at the hub shows the Hub pill and admits; stop the hub and the next scan goes to the VM with the Cloud-only pill.

## Done when

All of "Done when" for M4 in the plan holds (concurrency test passes; the hub keeps admitting with its uplink cut), and `bun run lint`, `bunx tsc --noEmit`, `bun run test` and `bun run test:e2e` pass.

## Summary for reviewer

Files changed:
What was done:
What to check:
Conflicts resolved: (none)

## Fix requests

(none)

## Blocker

(none)
