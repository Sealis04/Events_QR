> Exported 2026-10-21 from the Claude Docs spec (rev 48): https://claude.ai/artifact/FWS1zsJVNcFkvLe8wwf2Q7
> **Where this spec and `plans/offline-qr-ticketing/plan.md` differ, the plan wins.** In particular: no cloud services (self-hosted VM instead of cloud/KMS), MariaDB instead of Postgres, Next.js instead of Fastify, Gmail API instead of Postmark/SES, and the hub uses a Let's Encrypt cert (Cloudflare DNS-01) instead of a pinned self-signed cert.

# Offline QR Ticketing System — Technical Spec

Oct 16, 2026 · @Programmer

## Handoff: start here

> Updated 2026-10-21. Status: spec complete with re-entry, gate and time-slot rules, ready to build. No code exists yet.

**Summary**

This spec designs a ticketing system for 500–5,000-person events. Staff create an event, then generate one-time QR tickets inside it at the point of sale. The QR codes are signed and encrypted, so normal camera apps see gibberish and nobody can forge them. A hub at the venue enforces one-time entry across all gates, even with no internet, and scanners can still validate alone if the hub drops.

**Status**

- **Completed:** full technical spec covering architecture, token format, data model, issuance, scanner logic, hub sync, APIs, security, dashboard, event-day runbook, stack and milestones.
- **In progress:** nothing.
- **Not started:** all code. Build order is the milestone list under Stack, milestones and testing.

**Key decisions**

| Decision | Alternatives considered | Why |
| --- | --- | --- |
| QR holds a sign-then-encrypt token (Ed25519 + AES-256-GCM, Base45, `EVT1:` prefix) | Plain random id; a custom barcode format | Unreadable to cameras, unforgeable, verifiable offline, and keeps standard QR error correction |
| Venue hub is the live authority for "used", with scanner-only fallback | Cloud-only checks; each scanner on its own | Venue internet is unreliable; a hub keeps entry rules enforced across gates without it |
| Every ticket is created inside an event's QR generator | One global ticket pool | Binds each code to one event and its key |
| Any logged-in staff member can generate; `issued_by` records who | Per-event staff roles | Matches how tickets are tied to sales |
| No personal data inside the QR | Name or email in the payload | A leaked key or screenshot exposes nothing personal |
| Scanner is a PWA | Native app | No app-store install; works offline |
| TypeScript throughout, Postgres in the cloud, SQLite on the hub | Separate stacks per part | Token and claim logic written once and shared |
| Re-entry set per ticket type: single, unlimited or up to N entries, with an exit scan needed before re-entry | One event-wide on/off switch | Different ticket types need different rules; the exit scan stops a ticket being passed back out |
| Gate list and time slot are optional fields inside the signed QR | Stored only in the ticket list | Scanners can enforce them even with no synced list; costs 4 extra bytes |
| Phones join an event by scanning a `DEV1:` setup QR that sets their gate and role (entry, exit or both) | Typing codes; fixed exit hardware | Any phone can be an entry or exit; setup takes seconds and works offline through the hub |
| Ticket types in their own table with an `issued` counter | Capacity in event JSON | Fixes the capacity race |
| Staff generation only in v1; the issuance API stays ready for online checkout | Online checkout in v1 | Ships sooner; no rework later |
| Names kept 1 year, scan logs 3 years | 90 days and 1 year; defer to records policy | Covers audits and annual reporting |

**How to continue**

1. Done 2026-10-21: open questions answered; token, data model, scanner, hub claim and retention updated. Two smaller questions on exits and early entry remain at the end.
2. Capacity race is fixed in the spec (the ticket\_types table); build that transaction into the generator from the start.
3. Build milestone 1, the shared token library (34-byte payload), with test vectors for tampered, wrong-key, wrong-event, wrong-gate and out-of-slot tokens.
4. Continue through milestones 2–6, running the concurrency and chaos tests from the testing plan as the hub lands.
5. Run a full dress rehearsal before the first live event.

**Known risks and tech debt**

- **Capacity race:** two staff can oversell a ticket type at the same moment until ticket types get their own counted table.
- **Offline double entry:** a gate cut off from the hub can admit a shared screenshot that another gate already admitted. It is flagged after sync but can't be undone.
- **Event key on devices:** a stolen scanner can read ticket contents (not forge them); devices must be revocable and wiped after each event.
- **Clock drift:** conflict ordering trusts device clocks, which sync with the hub on every contact.
- **Dead phones:** scans in an unsynced outbox wait until the phone powers back on.

## Overview

The system issues one-time QR tickets that ordinary camera apps cannot read, and validates them at the door even with no internet, with near-zero double entry across gates.

**Goals**

- Issue tickets as signed, encrypted QR tokens that reveal nothing to a standard QR reader and cannot be forged.
- Validate each scan in under 300 ms, fully offline from the internet.
- Enforce one-time entry across all gates via a venue-local hub, with duplicates detectable afterward even when a gate was isolated.
- Give organisers a live dashboard of check-ins, manual overrides and an audit trail.

**Scale assumptions**

- 500–5,000 attendees per event; design target 5,000 with headroom to 10,000.
- 2–20 scanner devices across 1–6 gates.
- Peak entry rate around 1,500 scans in the first 30 minutes (about 1 scan/s overall, 0.2 scans/s per device).
- A full ticket list for 10,000 tickets is under 1 MB, so every device can hold it locally.

**Non-goals for v1**

- Payments and ticket resale (assume an external checkout or manual guest list feeds ticket creation).
- Rotating/animated QR codes and native wallet passes (listed as later milestones).
- Seat maps or reserved seating.

## Architecture

Four parts: a cloud server that issues tickets, a hub at the venue that decides entry, phone scanners at each gate, and an admin dashboard.

&#91;embedded content: system architecture · cloud, venue hub, scanners\]

During the event the hub alone decides "used". The cloud is needed only before doors (issuing, syncing tickets) and after (reconciling scans), so an internet outage at the venue changes nothing at the gates.

**Data flow**

1. **Before the event:** the cloud issues and emails tickets; the hub and every scanner download the ticket list and keys.
2. **During:** scanners send every claim to the hub over local Wi-Fi; if the hub is unreachable, a scanner validates alone and queues the scan.
3. **After:** the hub uploads all scans to the cloud, which flags any double admits for review.

## Ticket token format

Each QR holds a sign-then-encrypt token: the payload is signed with the server's Ed25519 private key, then encrypted with a per-event AES-256-GCM key, and printed as `EVT1:` plus Base45 text.

This gives three properties. A phone camera shows only meaningless text. A scanner can verify authenticity offline with just the public key. A stolen scanner can decrypt tickets but can never mint new ones, because the signing key never leaves the cloud server.

**Inner payload (binary, 34 bytes)**

| Field | Size (bytes) | Notes |
| --- | --- | --- |
| version | 1 | Starts at `0x01`; lets you change the format later |
| event\_id | 4 | Numeric event id; rejects tickets from other events |
| ticket\_id | 16 | 128-bit CSPRNG value; primary key of the ticket |
| ticket\_type | 1 | Index into the event's ticket types (GA, VIP, staff…) |
| issued\_at | 4 | Unix seconds; used to reject tickets issued after a revocation cut-off |
| key\_id | 1 | Which signing key generation was used, for rotation |
| entry\_rule | 1 | Top 2 bits = mode: `0` single entry, `1` unlimited re-entry, `2` limited re-entry. Low 6 bits = max admits for limited (2–63), else `0` |
| gate\_mask | 2 | One bit per gate, by position in the event's gate list (max 16 gates); `0` = any gate |
| slot\_start | 2 | Entry window start, minutes from 00:00 local on the event's first day (covers 45 days); `0xFFFF` = no time slot |
| slot\_end | 2 | Entry window end, same unit; `0xFFFF` = until the event ends |

**Assembly**

1. `sig = Ed25519_sign(sk_sign, payload)` gives 64 bytes.
2. `inner = payload || sig` gives 98 bytes.
3. `nonce = random(12)`, `ct = AES-256-GCM(k_event, nonce, inner, aad = "EVT1")` gives 98 bytes plus a 16-byte tag.
4. `token = "EVT1:" + Base45(nonce || ct || tag)`, which is 126 bytes encoded as about 189 characters.

**QR settings**

- Base45 uses only the QR alphanumeric character set, so the code stays dense: about version 8 (49×49 modules) at error-correction level M.
- Use level M (15% recovery); it tolerates cracked screens and glare without making the code too dense to scan quickly.
- Render at least 300×300 px in emails, with a 4-module quiet zone.

**Why not put the attendee name in the QR?** Personal data stays out of the code. The scanner looks the name up in its local ticket list by `ticket_id`, so a leaked screenshot exposes nothing personal even if the event key leaks.

**Validation order on the scanner:** check the prefix, decode Base45, decrypt with AES-GCM (failure means not ours or tampered), verify the Ed25519 signature, check `event_id` and `key_id`, then check status and one-time use (see Scanner app).

## Data model

Five core tables in Postgres on the cloud server. The hub and scanners keep a SQLite subset of `tickets` and `scans`.

```sql
CREATE TABLE events (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  starts_at     TIMESTAMPTZ NOT NULL,
  ends_at       TIMESTAMPTZ NOT NULL,
  enc_key_ref   TEXT NOT NULL,          -- KMS reference to the AES-256 event key
  sign_key_id   SMALLINT NOT NULL,      -- current Ed25519 key generation
  gates         TEXT[] NOT NULL,        -- ordered, max 16; position = bit in gate_mask; append-only once tickets exist
  config        JSONB                   -- venue and display settings
);

CREATE TABLE ticket_types (
  event_id      INTEGER REFERENCES events(id),
  idx           SMALLINT NOT NULL,      -- the ticket_type byte in the token
  name          TEXT NOT NULL,          -- GA, VIP, Staff…
  capacity      INTEGER,                -- NULL = no limit
  issued        INTEGER NOT NULL DEFAULT 0,  -- incremented in the same transaction as the ticket insert
  entry_mode    TEXT NOT NULL DEFAULT 'single', -- single | unlimited | limited
  max_admits    SMALLINT,               -- 2–63, required when entry_mode = 'limited'
  gate_mask     SMALLINT NOT NULL DEFAULT 0,    -- default for new tickets; 0 = any gate
  slots         JSONB,                  -- optional list of {start, end} windows the generator offers
  early_entry_min SMALLINT NOT NULL DEFAULT 15 CHECK (early_entry_min BETWEEN 15 AND 30), -- staff-set; synced, not in the QR
  PRIMARY KEY (event_id, idx),
  CHECK (capacity IS NULL OR issued <= capacity)
);

CREATE TABLE tickets (
  id            BYTEA PRIMARY KEY,      -- 16-byte ticket_id from the token
  event_id      INTEGER REFERENCES events(id),
  ticket_type   SMALLINT NOT NULL,
  holder_name   TEXT,                   -- required at issue; set to NULL 1 year after the event
  holder_email  TEXT,                   -- optional; QR can be shown or printed instead; purged with the name
  issued_by     UUID REFERENCES staff(id), -- staff member who made the sale
  token_nonce   BYTEA NOT NULL,         -- 12 bytes; lets re-send rebuild the same QR
  entry_mode    TEXT NOT NULL,          -- copied from the type at issue; matches the QR
  max_admits    SMALLINT,               -- 1 for single, NULL for unlimited, N for limited
  gate_mask     SMALLINT NOT NULL,      -- matches the QR; 0 = any gate
  slot_start    TIMESTAMPTZ,            -- NULL = no time slot
  slot_end      TIMESTAMPTZ,
  admits_used   SMALLINT NOT NULL DEFAULT 0,
  inside        BOOLEAN NOT NULL DEFAULT FALSE, -- last accepted scan was an entry
  status        TEXT NOT NULL DEFAULT 'valid',  -- valid | used_up | cancelled
  issued_at     TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL    -- drives incremental sync
);
CREATE INDEX ON tickets (event_id, updated_at);

CREATE TABLE devices (
  id            UUID PRIMARY KEY,
  event_id      INTEGER REFERENCES events(id),
  label         TEXT,                   -- e.g. "Gate A – phone 2"
  gate          TEXT NOT NULL,
  direction     TEXT NOT NULL DEFAULT 'entry',  -- entry | exit | both (toggle on screen)
  token_hash    TEXT NOT NULL,          -- device auth token (hashed)
  revoked       BOOLEAN DEFAULT FALSE,
  last_seen_at  TIMESTAMPTZ
);

CREATE TABLE staff (
  id            UUID PRIMARY KEY,
  name          TEXT NOT NULL,
  pin_hash      TEXT NOT NULL,
  role          TEXT NOT NULL           -- scanner | supervisor | admin
);

CREATE TABLE scans (                    -- kept 3 years, then deleted
  id            UUID PRIMARY KEY,       -- generated on the device (UUIDv7)
  ticket_id     BYTEA REFERENCES tickets(id),
  device_id     UUID REFERENCES devices(id),
  staff_id      UUID REFERENCES staff(id),
  gate          TEXT NOT NULL,
  direction     TEXT NOT NULL,          -- entry | exit
  scanned_at    TIMESTAMPTZ NOT NULL,   -- device clock
  received_at   TIMESTAMPTZ,            -- hub/cloud clock
  result        TEXT NOT NULL,          -- admitted | exited | rejected_used | rejected_inside | rejected_gate | rejected_slot | rejected_invalid | override
  offline       BOOLEAN NOT NULL,       -- true if decided without the hub
  conflict      BOOLEAN DEFAULT FALSE   -- set when sync finds admits beyond the ticket's limit
);
CREATE INDEX ON scans (ticket_id);
```

`scans` is append-only and is the source of truth for check-ins. `tickets.admits_used`, `inside` and `status` are a derived cache rebuilt from `admitted`, `override` and `exited` rows; a ticket becomes `used_up` once `admits_used` reaches `max_admits`. Scan ids are generated on the device, so replaying a sync batch is idempotent.

## Event setup and QR generator

The cloud is organised per event: an organiser creates an event first, and that event's page holds the QR generator. Every code is bound to that event's id and key, so it is rejected at any other event.

**Step 1: create the event**

| Field | Example | Used for |
| --- | --- | --- |
| Name | Summer Fest 2027 | Shown on tickets and scanners |
| Dates and times | Doors 17:00, start 18:00, end 23:00 | Scanner validity window, reports |
| Venue | Riverside Hall | Tickets and emails |
| Gates | Gate A, Gate B, VIP door | Device assignment, gate limits; max 16, and the order is fixed once tickets exist |
| Ticket types | GA, VIP, Staff, each with an optional capacity, allowed gates, entry rule and time slots, with an early-entry allowance staff set from 15 to 30 min (default 15) | Dropdown in the generator; capacity checks |
| Re-entry | Set per ticket type: single entry (default), unlimited re-entry, or up to N entries | Scanner rules |

On save, the server assigns the `event_id` and creates the event's AES-256 key in KMS. The event then gets its own page with tabs for the generator, the ticket list, devices and live stats.

**Step 2: generate QR codes from the event page**

The person issuing tickets types the attendee's details there and then:

- Holder name (required).
- Ticket type, from the event's types.
- Email or phone (optional, only needed to send the ticket).
- Gate restriction (optional; defaults to the ticket type's gates).
- Time slot (optional; a pick from the type's slots, or a custom start and end).
- Entry rule (defaults to the ticket type's; supervisors can override per ticket).
- Quantity, for batches such as 20 staff passes, which get numbered names if left blank.
- Internal note (optional, e.g. "sponsor guest").

Pressing **Generate** creates the ticket row, mints the signed, encrypted token, and shows the QR on screen in under a second. Actions on the result: Email, Download PNG, Print or PDF, and **Generate another**, which keeps the ticket type selected for fast repeat entry.

**Rules**

- Any logged-in staff member can generate tickets, usually when recording a sale. Each ticket records who issued it (`issued_by`), which ties tickets to sales.
- Generation stops at a ticket type's capacity unless an admin raises it.
- New tickets reach the venue hub within 30 s. A ticket generated while the venue has no internet still verifies by signature and shows AMBER, so a supervisor can admit it with one tap (useful for door sales).

> **Capacity race: fixed in this spec (2026-10-21).** Ticket types now live in `ticket_types` with an `issued` counter. The generator increments it in the same transaction as the ticket insert: `UPDATE ticket_types SET issued = issued + 1 WHERE event_id = ? AND idx = ? AND (capacity IS NULL OR issued < capacity)`. If no row changes, the type is sold out and nothing is created.

## Ticket issuance and delivery

Tickets are created server-side only, mainly from each event's QR generator (above), with checkout webhooks and CSV import as optional extra sources. Delivery is on screen, by email, or printed.

1. **Create:** insert a `tickets` row with a fresh 16-byte `ticket_id` from a CSPRNG, holder details and type. Wrap it in a transaction with the source order id to stay idempotent on webhook retries.
2. **Mint the token:** build the payload, sign, encrypt and Base45-encode it as in Ticket token format. Do this in a single signing service, the only process that can reach the Ed25519 private key.
3. **Render:** generate the QR as PNG (for email) and SVG (for the PDF). Print the holder name, event, ticket type and the last 6 characters of the ticket id in hex under the code, so staff can search manually if a code won't scan.
4. **Deliver:** send via a transactional email provider, queued with retries. Store the delivery status for support.
5. **Re-send:** "Resend ticket" regenerates the same token deterministically from stored fields and the original nonce. Do not reissue a new id, or old screenshots and the email would diverge.
6. **Cancel or transfer:** cancelling sets `status = cancelled`. Transferring cancels the old ticket and issues a new one, so the old QR stops working. Both bump `updated_at`, so the change reaches scanners on the next sync.

Deterministic re-send means storing the nonce per ticket (12 bytes). Alternatively, store the full token string; at 5,000 tickets that is under 1 MB either way.

**Online checkout (later).** v1 issues tickets only through the staff QR generator. `POST /events/{id}/tickets` already takes an idempotency key and returns the QR, so a future checkout can call it with a service credential. It must pass the same capacity transaction and record the checkout order id instead of `issued_by`. No checkout code ships in v1.

## Scanner app

The scanner is an installable PWA on staff phones. It asks the venue hub first, and only decides alone when the hub is unreachable for more than 800 ms.

**Device setup.** A phone becomes a scanner for one event by scanning a setup QR. Gates and roles are set inside the app this way, so any phone can serve as an entry, exit or both.

1. In the dashboard, a supervisor opens the event's Devices page, picks **Add scanner**, and chooses a gate, a role (entry, exit or both) and an optional label such as "Gate A – phone 2".
2. The dashboard shows a setup QR starting with `DEV1:`. It holds the event id, a one-time enrolment code (single use, expires after 10 minutes), the hub address and the hub's certificate fingerprint. It carries no keys or ticket data.
3. On the phone, staff tap **Set up for event** and scan it. The app calls `POST /enroll` on the hub, or the cloud if no hub is reachable, and gets back a device token, the event key bundle, its gate and role.
4. The app runs a full ticket sync, then shows a ready screen with the event, gate and role (e.g. "Gate A · Entry"). Only then does it accept `EVT1:` ticket codes.
5. To move a phone to another gate or switch it to exit duty, a supervisor changes it on the Devices page; the change reaches the phone on its next sync. Scanning a new setup QR also reassigns it. Revoking a device on that page wipes its keys at the next sync.

A role of **both** shows an Entry / Exit toggle on the scan screen, and every scan records which was used. The hub keeps a list of unused enrolment codes pulled from the cloud, so setup works with no internet.

**Local state on each device**

- The event's AES key and Ed25519 public keys, delivered at device enrolment.
- A ticket table (`id`, `type`, `holder_name`, `status`, `admits_used, inside`) of about 100 bytes × 5,000 rows, around 0.5 MB in IndexedDB.
- A set of used ticket ids learned from the hub, plus its own scans.
- An outbox of scan records not yet acknowledged by the hub.

**Validation algorithm**

```text
on scan(raw, direction):                  # direction = device mode: entry | exit
  if not raw.startsWith("EVT1:")         -> RED "Not an event ticket"
  p = decrypt_and_verify(raw)              # AES-GCM, then Ed25519
  if fails                                 -> RED "Invalid / forged"
  if p.event_id != current_event          -> RED "Wrong event"
  t = local_tickets[p.ticket_id]
  if t is missing                          -> AMBER "Valid signature, not in list – call supervisor"
  if t.status == cancelled                 -> RED "Cancelled"

  if direction == exit:
     if p.entry_rule.mode == single        -> GREY "No re-entry on this ticket" (log exit, no state change)
     r = hub ? hub.exit(...) : local_exit(t)   # sets inside = false
     return BLUE "Exit recorded"

  # entry checks use the signed QR fields, so they work with no ticket list at all
  if p.gate_mask != 0 and bit(gate_index) not set in p.gate_mask
                                           -> RED "Use " + allowed_gate_names(p.gate_mask)
  if p.slot_start != NONE and now < slot_start - type.early_entry_min
                                           -> RED "Too early – slot starts " + slot_start
  if p.slot_end != NONE and now > slot_end -> RED "Slot ended at " + slot_end

  if hub reachable:
     r = hub.claim(ticket_id, scan_id, device, gate)   # atomic on hub
     return r.admitted ? GREEN("Entry " + r.admits_used + " of " + limit)
                       : RED(r.reason)                # used up | still inside | first-scan details
  else:
     s = local_state[ticket_id]
     if s.inside                           -> RED "Already inside (offline)"
     if limit and s.admits_used >= limit   -> RED "No entries left (offline)"
     s.admits_used += 1; s.inside = true; outbox.push(scan, offline=true)
     return GREEN with "OFFLINE" banner
```

The AMBER state covers a ticket that was issued after the device last synced. The signature proves it is genuine, so a supervisor can admit it with one tap, logged as `override`.

**Result screen**

| State | Colour and sound | Shows | Auto-dismiss |
| --- | --- | --- | --- |
| Admitted | Full-screen green, short beep, vibration | Holder name, ticket type, entry count (e.g. 2 of 3) for re-entry tickets | 1.5 s |
| Exit recorded | Full-screen blue, double beep | Holder name, entries left | 1 s |
| Already used or still inside | Full-screen red, long buzz | Last scan's gate, time and device | Tap to dismiss |
| Invalid, wrong event, wrong gate or outside slot | Full-screen red | Reason, plus the right gate or the slot times | Tap to dismiss |
| Needs supervisor | Amber | Name if known, override button (supervisor PIN) | Tap to dismiss |

**Other behaviour**

- Debounce the same code for 3 s, so one QR held under the camera doesn't scan twice and show a false "already used".
- A connection pill is always visible: Hub (green), Cloud-only (blue) or Offline (orange), with the outbox count.
- Manual search by name or the last 6 hex characters for codes that won't scan.
- Use the `BarcodeDetector` API where supported, falling back to a WASM decoder (e.g. ZXing); target under 300 ms from frame to result.

## Venue hub and sync protocol

The hub is a small machine on its own Wi-Fi at the venue. It is the live authority for "used" during the event, and it syncs with the cloud whenever internet exists.

**Hardware and network**

- A mini PC or Raspberry Pi 5 with SSD, running the hub service with SQLite in WAL mode. 5,000 tickets and 10,000 scans is trivial load.
- A dedicated router with its own SSID (WPA2/3, hidden password), with a mesh node or access point per gate if gates are more than about 30 m apart. Put the hub on a small UPS.
- Uplink via venue internet or a 4G/5G dongle; the event must work with the uplink down.
- A second hub on cold standby with the same ticket snapshot; scanners can be pointed at it by switching SSID.

**The claim (atomic one-time check)**

```sql
-- entry (single = max_admits 1, unlimited = NULL, limited = N)
BEGIN IMMEDIATE;
INSERT INTO scans (...) VALUES (...)             -- id from device, ON CONFLICT DO NOTHING
UPDATE tickets
   SET admits_used = admits_used + 1,
       inside      = 1,
       status      = CASE WHEN max_admits IS NOT NULL AND admits_used + 1 >= max_admits
                          THEN 'used_up' ELSE status END,
       updated_at  = ?
 WHERE id = ? AND status = 'valid' AND inside = 0;
-- changes() = 1 -> admitted (return admits_used)
-- changes() = 0 -> read the row: inside -> rejected_inside, used_up -> rejected_used
COMMIT;

-- exit (re-entry tickets only)
BEGIN IMMEDIATE;
INSERT INTO scans (...) VALUES (...)             -- direction = 'exit', result = 'exited'
UPDATE tickets SET inside = 0, updated_at = ?
 WHERE id = ? AND inside = 1 AND entry_mode <> 'single';
COMMIT;
```

Re-entry tickets must be scanned out before they can come back in; `inside = 0` is what lets the next entry through. That stops one ticket being passed back over the fence to a second person. A used-up limited ticket can still exit.

SQLite serialises writers, so two gates claiming the same ticket in the same millisecond cannot both succeed.

**Sync loops**

| Loop | Direction | Trigger | Payload |
| --- | --- | --- | --- |
| Ticket pull | Cloud to hub | Every 30 s and on demand | Tickets with `updated_at` after the last cursor (new, cancelled, transferred) |
| Scan push | Hub to cloud | Every 5 s when online | Scans not yet acknowledged, batched up to 500 |
| Device pull | Hub to scanner | Every 10 s and on reconnect | Ticket changes and newly used ids since the device's cursor |
| Device push | Scanner to hub | Immediately; retried from the outbox | Offline scan records |

Cursors are monotonic `(updated_at, id)` pairs, and every write is idempotent on its id, so any loop can be retried safely.

**Conflict handling**

- When an offline scan arrives at the hub for a ticket already used, the hub keeps both rows, sets `conflict = true` on the later one, and alerts the dashboard.
- The first admit by `scanned_at` is the canonical one. Device clocks are trusted to plus or minus a few seconds because devices sync their clock with the hub on every contact.
- Conflicts can't be undone (both people are inside), so they are for follow-up: flag the ticket and its buyer, and measure how much offline time leaked.
- Cancellations win over pending offline admits only for future scans; a ticket admitted offline before its cancellation synced stays admitted and is flagged.

**Reducing offline exposure**

- Scanners fall back to offline only after the hub fails to answer within 800 ms, and retry the hub on every scan.
- An offline device beeps every 60 s and shows the orange banner, so supervisors notice and fix it.
- Optional per-gate rule: offline devices admit only tickets whose `allowed_gates` includes that gate.

## APIs

Two JSON-over-HTTPS APIs share one shape: the cloud API, and the hub API, which mirrors the scanner-facing subset so a scanner can talk to either.

**Cloud API**

| Method and path | Caller | Purpose |
| --- | --- | --- |
| `POST /events` | Admin | Create an event; generates its AES key in KMS |
| `POST /events/{id}/tickets` | Staff (QR generator); online checkout later | QR generator: create one or many tickets from entered details and return the QR images immediately (idempotency key required) |
| `POST /tickets/{id}/cancel` | Admin | Cancel a ticket |
| `POST /tickets/{id}/resend` | Admin, attendee self-service | Re-send the email |
| `POST /devices/enroll` | Supervisor | Create a setup QR (gate, role, label) and later exchange its one-time code for a device token, key bundle and device settings |
| `GET /sync/tickets?cursor=` | Hub | Ticket changes since the cursor, paginated |
| `POST /sync/scans` | Hub | Upload a batch of scans; returns the acknowledged ids and conflicts |
| `GET /events/{id}/stats` | Dashboard | Live counts by gate and ticket type |

**Hub API (scanner-facing)**

| Method and path | Purpose |
| --- | --- |
| `POST /enroll` | Exchange a setup QR's one-time code for a device token, key bundle, gate and role; works offline from the hub's cached codes |
| `POST /claim` | Atomic entry check-and-mark; body `{scan_id, ticket_id, device_id, staff_id, gate, scanned_at}`; returns `admits_used` and the limit |
| `POST /exit` | Record an exit for a re-entry ticket; same body; sets `inside` to false |
| `GET /sync?cursor=` | Ticket changes (including `admits_used` and `inside`), device setting changes (gate, role, revoked) since the cursor, plus the hub time for clock sync |
| `POST /scans` | Upload outbox scans recorded offline |
| `GET /health` | Liveness and last cloud sync time, for the connection pill |

`/claim` responses are `{result: "admitted" | "rejected_used" | "rejected_cancelled", first_scan?: {gate, at, device}}`. Every request carries the device bearer token; staff identity rides in the body after PIN login on the device.

## Security

The signing key is the crown jewel and never leaves the cloud. Everything on venue devices is assumed stealable, so losing a phone can at worst leak attendee names, never let anyone forge entry.

**Keys**

| Key | Lives in | On venue devices? | If compromised |
| --- | --- | --- | --- |
| Ed25519 signing key | Cloud KMS/HSM, used only by the signing service | No (public key only) | Forgery possible; rotate `key_id`, reissue all tickets |
| AES-256 event key | KMS; delivered to enrolled devices | Yes, in memory and encrypted IndexedDB | Tokens become readable, but still unforgeable; low impact |
| Device bearer token | Device, hashed on server | Yes | Revoke the device; it stops syncing and claiming |
| Staff PIN | Hashed (argon2id) | No | Reset the PIN |

**Threat model**

| Threat | Mitigation |
| --- | --- |
| Forged QR codes | Ed25519 signature; private key only in KMS |
| Screenshot shared with a friend | One-time claim at the hub; offline duplicates flagged at sync |
| Guessing ticket ids | 128-bit random ids, and tokens must also be validly signed |
| Reading ticket data with a normal camera | AES-GCM encryption; no personal data in the token anyway |
| Lost or stolen scanner | Device revocation, PIN-gated app, keys deleted after the event |
| Rogue device on the hub network | WPA2/3 network plus device tokens on every hub call |
| Staff admitting friends via override | Supervisor-only overrides, all logged with staff id, shown on the dashboard |
| Replay of a captured `/claim` request | TLS on the hub (self-signed cert pinned at enrolment) and unique `scan_id` per claim |

**After the event:** wipe event keys and ticket lists from devices, rotate the event AES key, and keep scans for audit under the retention rule below.

**Data retention.** Attendee names and contact details are kept 1 year after the event ends, then a nightly job sets `holder_name` and `holder_email` to NULL. Scan logs are kept 3 years after the event, then deleted. Ticket ids, types and counts stay for reporting, since they identify no one. Hub and scanner copies are wiped right after each event.

## Admin dashboard and event-day operations

The dashboard runs against the cloud before and after the event, and against the hub during it, so it keeps working when the internet drops.

**Dashboard features**

- Live check-ins: total, per gate, per ticket type, and a scans-per-minute line.
- Device panel: each scanner's connection state, outbox size, last-seen time and battery.
- Attendee search by name, email or the last 6 characters of the ticket id; manual admit (logged as an override).
- Conflict feed: double admits with both scans side by side.
- Per-event workspace: event setup, QR generator, ticket list, import CSV, cancel, re-send, export.

**Event-day runbook**

1. **T−24 h:** set up every phone by scanning its setup QR, check each ready screen shows the right gate and role, load the latest ticket snapshot on the hub and the standby hub, and test-scan one ticket of each type at each gate.
2. **T−2 h:** power up the hub, router and access points; confirm every device shows Hub (green); run a forced ticket pull.
3. **T−15 min:** final ticket pull; freeze online sales or accept that later buyers will show AMBER until the next sync.
4. **Doors:** a supervisor watches the device panel; any device on orange for more than 2 min gets moved or fixed.
5. **After doors:** let the hub push all scans to the cloud, review conflicts, then wipe devices.

**Failure modes**

| Failure | What happens | Response |
| --- | --- | --- |
| Internet down | Nothing visible; the hub keeps working | Ticket pulls pause; new sales show AMBER |
| Hub down | Scanners go offline mode within 800 ms | Switch scanners to the standby hub's SSID |
| Gate access point down | That gate scans offline | Small duplicate risk at that gate only; fix the access point |
| Phone dies | Its unsynced outbox is lost until it powers back on | Keep power banks at each gate; outbox persists across restarts |
| Code won't scan | — | Manual search by name or short id |

## Stack, milestones and testing

A single TypeScript codebase covers all four parts, so the token and claim logic is written once and shared.

**Suggested stack**

| Part | Choice | Why |
| --- | --- | --- |
| Cloud API | Node.js + Fastify, Postgres | Simple, fast; Postgres handles the scale easily |
| Hub | Same Node service in hub mode, SQLite (better-sqlite3) | One binary; SQLite gives serialised atomic claims |
| Scanner | PWA (React or Svelte), IndexedDB, `BarcodeDetector` with ZXing-WASM fallback | No app-store install; works offline |
| Dashboard | Same PWA, admin routes | Shares components and auth |
| Crypto | libsodium (`crypto_sign` Ed25519) + WebCrypto AES-GCM | Audited, available in Node and browsers |
| Keys | Cloud KMS (AWS KMS, GCP KMS) | Signing key never exported |
| QR and email | `qrcode` npm package; Postmark, SES or similar | Base45 alphanumeric mode supported |

**Milestones**

1. **Core tokens:** shared library for build, sign, encrypt and verify, with test vectors.
2. **Cloud issuance:** events, tickets, CSV import, email delivery.
3. **Online scanner:** PWA scanning against the cloud `/claim`; green/red UI.
4. **Hub:** hub mode, device enrolment, all sync loops.
5. **Offline mode:** local validation, outbox, conflict detection.
6. **Dashboard:** live stats, device panel, conflict feed, overrides.
7. **Dress rehearsal:** a full test event (see below).
8. **Later:** rotating QR codes in a ticket wallet page, Apple/Google Wallet passes, re-entry.

**Testing plan**

- Unit tests for token round-trips, tampered bytes, wrong keys, wrong event and an expired `key_id`.
- Concurrency test: 20 simulated devices claiming the same 100 tickets simultaneously; expect exactly 100 admits.
- Chaos test: randomly cut hub and access-point connectivity during a 5,000-scan simulation; reconcile scans and confirm every conflict is flagged.
- Field test: print 50 tickets, scan from cracked phones, dim screens, and paper at real gates with real staff.

**Open questions**

All four were answered on 2026-10-21 and are recorded in Key decisions: re-entry is set per ticket type, gates and time slots are optional QR fields, staff issue tickets now with online checkout later, and names are kept 1 year and scan logs 3 years.

- Exits: resolved 2026-10-21. Any phone can be set to entry, exit or both through its setup QR (see Device setup under Scanner app).
- Early entry: resolved 2026-10-21. Staff set an allowance of 15–30 minutes per ticket type (default 15). It syncs to scanners rather than living in the QR, so it can be changed on the day; supervisors can still override for anyone outside it.
