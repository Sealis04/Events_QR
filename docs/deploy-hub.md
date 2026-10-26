# Deploying the venue hub

The hub is one small machine at the venue. During the event it is the only authority for "has this ticket been used": every gate's phone asks it first, over the venue Wi-Fi, and it keeps working with no internet. Whenever internet exists it syncs with the VM (`docs/deploy-vm.md`). It runs two containers from `docker/compose.hub.yml`:

| Container | What it does                                                                                                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `app`     | The same Next.js build as the VM, started with `APP_MODE=hub`. Serves the scanner PWA and the scanner-facing API from SQLite.             |
| `worker`  | The sync loops: ticket pull from the VM every 30 s, scan push to the VM every 5 s, with backoff while the uplink is down.                 |
| `migrate` | One-shot: creates or upgrades the SQLite file, then exits.                                                                                |
| `proxy`   | Optional (`--profile proxy`): Nginx Proxy Manager for HTTPS on `hub.<domain>` (section 4).                                                |
| `dns`     | Optional (`--profile dns`): dnsmasq answering `hub.<domain>` locally when the venue router cannot (section 5).                            |

**What is on the hub, and what is not.** The hub verifies tickets and claims them; it can never make one. It holds the event's AES key, the Ed25519 _public_ keys, the ticket list (names included), the staff list with PIN hashes, device token hashes, and its own credential for the VM, all inside one SQLite file on a Docker volume. It has no signing key, no MariaDB, no passphrase and no Cloudflare token in its configuration, and in hub mode every admin and issuance route answers 404. The one dashboard it serves is read-only (event, live stats, devices, conflicts, attendee search) plus a supervisor's manual admit; supervisors and admins log in to it with the PIN hashes the VM sent for this event (plain staff get no dashboard session). Issuance, setup, cancellation and marking conflicts reviewed stay on the VM.

```text
 phones ──Wi-Fi──▶ hub (app + SQLite) ◀──worker──▶ VM (MariaDB)        when internet exists
 phones ──────────────────────────────────────────▶ VM                  only if the hub does not answer in 800 ms
```

## 1. Hardware and network

- **The machine.** A mini PC or a Raspberry Pi 5 with an **SSD** (not an SD card: the hub writes every scan with `synchronous = FULL`). 5,000 tickets and 10,000 scans is trivial load; 4 GB of RAM is plenty. Put it on a **small UPS** and wire it to the router with Ethernet.
- **The Wi-Fi.** A dedicated router with its own SSID (WPA2/3, password not printed on the ticket), with an access point or mesh node per gate if gates are more than about 30 m apart. Give the hub a **fixed LAN address** (a DHCP reservation on the router); this guide uses `192.168.50.10`.
- **The uplink.** Venue internet or a 4G/5G dongle on the router. The event must work with it down; it only matters for syncing with the VM.
- **The clock.** Phones correct their clock against the hub's on every sync, so the hub's clock must be right. The Pi has no battery-backed clock by default: make sure NTP is working before you leave for the venue (`timedatectl status`, `System clock synchronized: yes`), and do not reboot it at the gate without internet if you can avoid it.
- **A standby.** A second machine set up the same way (section 7).

## 2. Install

On the hub (Linux with Docker and the Compose plugin):

```bash
git clone <this repo> events-qr && cd events-qr
docker compose -f docker/compose.hub.yml up -d --build
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"mode":"hub","last_cloud_sync_at":null,"pending_scans":0}
```

No `.env` is needed. These optional settings can go in an `.env` next to the compose file and be passed with `--env-file .env`:

| Variable                                    | Default | Meaning                                                                                                                                       |
| ------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `HUB_BIND`, `HUB_PORT`                      | `0.0.0.0`, `3000` | Where the app listens on the host. Use `127.0.0.1` if the TLS proxy runs on this machine and the LAN should only see HTTPS.        |
| `HUB_TICKET_PULL_SECONDS`                   | `30`    | How often the hub pulls the event, tickets, staff, devices and the VM's scans.                                                                |
| `HUB_SCAN_PUSH_SECONDS`                     | `5`     | How often the hub uploads its scans and the phones enrolled at it.                                                                            |
| `SYNC_HORIZON_SECONDS`                      | `2`     | Rows younger than this are held back from sync pages, so a change committed in the same second can never fall behind a cursor.               |
| `HUB_MAX_BACKOFF_SECONDS`, `HUB_VM_TIMEOUT_SECONDS` | `60`, `10` | Longest wait between retries while the VM is unreachable, and the timeout of each request to it.                                  |

The SQLite file lives on the `hub-data` volume at `/data/hub.sqlite`. **Back it up or not, as you like, but never copy it to the VM or into the repo:** it contains the event key and the hub's credential.

## 3. Bind the hub to an event

Once per event, with internet. A supervisor on the VM creates a one-time setup code (valid 10 minutes; see `docs/deploy-vm.md` section 9 for the `curl`), and on the hub:

```bash
docker compose -f docker/compose.hub.yml run --rm tools \
  bun scripts/hub-enroll.ts https://tickets.example.org <setup code>
# hub linked to https://tickets.example.org for event 1: 1204 tickets, 0 scans
```

This exchanges the code for the hub's credential and the key bundle (event key, public keys, gates), stores them in the SQLite file, and runs a first full sync. Check it:

```bash
curl -s http://127.0.0.1:3000/api/health      # last_cloud_sync_at is now a recent Unix time
docker compose -f docker/compose.hub.yml logs -f worker
```

One hub serves one event. To use the machine for another event, wipe it first (section 8) and enrol it again.

## 4. HTTPS on `hub.<domain>`

Phones load the scanner from the hub and call it over HTTPS (browsers will not install a PWA or use the camera over plain `http://` on a LAN name). Self-signed certificates cannot be pinned by browsers, so the hub uses a real **Let's Encrypt certificate for a name you own, issued with the Cloudflare DNS-01 challenge**: the certificate is proven through a DNS record, so the hub itself never has to be reachable from the internet.

### Cloudflare record

Add an `A` record `hub` for your zone pointing to the hub's **LAN address** (`192.168.50.10`), set to **DNS only** (grey cloud, not proxied). A private address in public DNS is fine: only phones on the venue network can use it.

Create a Cloudflare API token limited to **Zone → DNS → Edit** on that one zone. It is used only to answer the DNS-01 challenge; it never goes into this repository, into `.env`, or into the app's configuration.

### Option A: Nginx Proxy Manager on the hub

```bash
docker compose -f docker/compose.hub.yml --profile proxy up -d proxy
```

Open `http://<hub LAN address>:81` (first login `admin@example.com` / `changeme`, change it at once), then:

1. **SSL Certificates → Add → Let's Encrypt via DNS**: domain `hub.example.org`, DNS provider **Cloudflare**, paste the token as `dns_cloudflare_api_token = <token>`. NPM stores it in its own volume and renews the certificate on its own.
2. **Proxy Hosts → Add**: domain `hub.example.org`, scheme `http`, forward hostname `app`, port `3000`, Block Common Exploits on. SSL tab: the certificate above, Force SSL, HTTP/2.
3. Set `HUB_BIND=127.0.0.1` so the only way in from the LAN is HTTPS.

### Option B: certbot-dns-cloudflare and your own nginx

```bash
sudo install -m 600 /dev/null /etc/letsencrypt/cloudflare.ini
echo 'dns_cloudflare_api_token = <token>' | sudo tee /etc/letsencrypt/cloudflare.ini >/dev/null
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini -d hub.example.org
echo '0 3 * * 1 root certbot renew --quiet --deploy-hook "systemctl reload nginx"' | sudo tee /etc/cron.d/certbot-hub
```

Point nginx at `/etc/letsencrypt/live/hub.example.org/{fullchain,privkey}.pem` and `proxy_pass http://127.0.0.1:3000;` with `Host`, `X-Forwarded-Proto` and `X-Forwarded-For` forwarded.

### Renewal needs internet

Let's Encrypt certificates last 90 days and are renewed when 30 days remain. **The hub needs internet at least every ~60 days** to renew; a hub that sits in a cupboard for the whole winter and is switched on at the gate with no uplink will serve an expired certificate and phones will refuse it. Put the hub on a normal network a week before every event, run `certbot renew` (or look at the certificate in NPM), and check the expiry date: `echo | openssl s_client -connect hub.example.org:443 -servername hub.example.org 2>/dev/null | openssl x509 -noout -enddate`.

## 5. Making `hub.<domain>` resolve with no internet

Public DNS is not reachable when the uplink is down, and some routers refuse to hand out private addresses from public DNS ("DNS rebinding protection"). Either way the venue network must answer `hub.example.org` itself.

Works with any router (full steps with TP-Link Archer menus: `docs/setup-guide.md` step 4.6):

1. **Fixed address for the hub:** a DHCP reservation in the router, e.g. `192.168.50.10`.
2. **Start the hub's DNS service:** `HUB_DOMAIN=hub.example.org HUB_LAN_IP=192.168.50.10 HUB_DNS_BIND=192.168.50.10 docker compose --env-file .env -f docker/compose.hub.yml --profile dns up -d dns`. Everything but the hub's name is forwarded to `1.1.1.1` while the internet is up. `HUB_DNS_BIND` limits port 53 to the LAN address; on Ubuntu that avoids the clash with `systemd-resolved` (`127.0.0.53:53`), or set `DNSStubListener=no` in `/etc/systemd/resolved.conf` and restart it.
3. **Router DHCP:** Primary DNS = the hub's address, Secondary DNS **empty**. Phones renew the lease when Wi-Fi is switched off and on.

When the hub is off, phones on that Wi-Fi cannot resolve names; keep the hub on a UPS.

**Alternative, if the router can hold a name override** (OpenWrt: _Network → DHCP and DNS → Hostnames_ or an `address=/hub.example.org/192.168.50.10` line in dnsmasq; pfSense/OPNsense: _Host Overrides_; UniFi: _Local DNS Records_; Omada: local DNS records): `hub.example.org` → `192.168.50.10`.

Check from a phone on the venue Wi-Fi **with the uplink unplugged**: open `https://hub.example.org/api/health`. It must show the JSON with `"mode":"hub"` and a padlock, not an error page.

## 6. Setting up phones

On the VM set `HUB_URL=https://hub.example.org` (and, optionally, `PUBLIC_URL=https://tickets.example.org`) in `.env` and recreate the app. From then on every `DEV1:` setup QR carries the hub's address.

The phone sets itself up by trying **the hub first (3 s), then the page's own server (the VM)**. Enrolling at the hub works with no internet from the hub's cached codes, and the new phone becomes a valid device on the VM on the hub's next push (within about 5 s once the uplink is back). The hub's answer also tells the phone where the VM is, for the fallback.

A normal setup code (the on-screen QR) lasts 10 minutes and the hub learns new codes on its next pull (30 s), so it works at the hub from about half a minute after a supervisor made it.

**Phones that must be set up with no internet** use a batch of hub codes instead: on the event page of the VM, under "Phone setup codes for the venue hub", pick a gate and role and make, say, 10 codes. They stay valid **until the event's end time**, each works once, and the page shows them as printable QRs (the codes are stored hashed, so they are shown only at that moment; print them then). The hub caches them on its next pull (30 s) and keeps handing them out with the uplink down. A code used at the hub is marked used on the VM after the next push, and a code used on the VM stops working at the hub after the next pull. The API is `POST /api/devices/enroll` with `{"event_id":…,"gate":…,"direction":…,"for_hub":true,"count":10}`; the answer has `setup_qrs`.

Every scan asks the hub first and waits 800 ms. The pill on the phone says which server decided:

| Pill                  | Meaning                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Hub** (green)       | The hub answered. This is the normal state.                                                                                              |
| **Cloud-only** (blue) | The hub did not answer in time, the VM did. Safe, but the hub is not seeing these scans live: find out why.                              |
| **Offline** (orange)  | Neither answered. The phone decides alone with its own copy of the ticket list and shows an orange `OFFLINE` bar; its scans are saved and uploaded when a link is back. |

The hub is asked again on every scan, so a hub that comes back is used straight away. Staff PIN login also tries the hub first; the hub has the staff list (with PIN hashes) mirrored from the VM, so logging in works with no internet.

## 7. Event day

The step-by-step checklist for staff and supervisors is `docs/runbook.md`; the rehearsal that proves the setup is `docs/field-test.md`.

**Before the doors open** (about 30 minutes, with internet):

1. `curl -s https://hub.example.org/api/health` → `last_cloud_sync_at` within the last minute, `pending_scans` 0.
2. Make sure the last ticket you issued is on the hub: scan it on a phone that shows **Hub**.
3. Walk each gate with a phone and check the pill.
4. Note the certificate's expiry date (section 4).

**If the uplink drops:** nothing to do. The hub keeps admitting and exiting; the worker retries with a growing delay (the log says `hub push: ...; retrying` once, then `the VM is back`). New tickets issued on the VM in the meantime reach the hub when the uplink returns, and a phone that scans one the hub has not got yet gets "ticket not found" until then (the hub asks the VM on demand while it can).

**If the hub dies:** phones fall back to the VM after 800 ms per scan and show **Cloud-only**. To bring up the standby, section 7.1.

**After the doors close:** keep the uplink up until `pending_scans` is 0 on `/api/health`, and compare the VM's count (`GET /api/events/<id>/stats`, `total_admitted`) with the hub's. If a ticket was admitted both at the hub and, while the hub was unreachable, at the VM, both scans are kept and the later one by `scanned_at` is flagged `conflict` on both sides.

### 7.1 Standby hub

Set up a second machine exactly as above and enrol it with **its own setup code** (`hub-enroll` creates a separate credential). It then pulls the same tickets, staff and devices. Keep it **off the venue network** (or powered off) until needed, because two hubs answering at once would each decide "first scan" alone.

To fail over: switch the standby on the venue network, give it the primary's LAN address (or point the router's `hub.example.org` override at its address), and use the same certificate (copy `/etc/letsencrypt/live/hub.example.org` or issue it separately with the same DNS-01 token). Phones need no change; they find the hub by name. Phones that were enrolled at the failed primary are known to the standby once the primary's last push reached the VM and the standby pulled it; devices enrolled at the primary after its last successful push must be enrolled again.

## 8. After the event

1. Check `pending_scans` is 0 and the VM's stats match.
2. Wipe the hub: `docker compose -f docker/compose.hub.yml down -v`. This deletes the SQLite volume: the ticket list, the staff list and the event key.
3. On the VM revoke the hub's credential (`UPDATE devices SET revoked = 1 WHERE kind = 'hub' AND event_id = <id>;`), and consider rotating the event key as the spec's "After the event" section says.
4. Wipe the phones (revoke them on the VM's Devices tab; "Set up again" on the phone wipes it too, after uploading its queue and, if scans are stuck, a supervisor PIN. If a phone cannot get online, clear the browser's site data by hand).

## 9. How the sync works

| Loop                             | Direction   | Runs                                  | What it moves                                                                                                                                                   |
| -------------------------------- | ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull (`GET /api/sync/meta`, `/tickets`, `/scans`) | VM to hub   | every 30 s and when a claim names an unknown ticket | Event, ticket types, staff, scanner devices (incl. revocations), unused phone codes; tickets after a `(updated_at, id)` cursor; the VM's own scans after a `(received_at, id)` cursor. |
| Push (`POST /api/sync/devices`, `/scans`) | hub to VM   | every 5 s                             | Phones enrolled at the hub (with the code they used), then scans in batches of up to 500, idempotent on `scan_id`.                                              |
| Device pull (`GET /api/sync`)    | hub to phone | every 10 s by the phone              | Ticket changes including `admits_used`, `inside` and what other gates admitted, the phone's own gate and role, and the hub's clock.                             |

Rules that make the loops safe to retry:

- Every write is idempotent on its id (ticket id, scan id, device id). A cursor only moves after its page is stored.
- A pull never undoes what the hub decided: for a ticket the hub knows, the VM's `admits_used` and `inside` are ignored; only scans change them. A cancellation on the VM always wins for future scans.
- Both sides rebuild a ticket's state from its scans in `(scanned_at, id)` order. An entry while the holder is already inside, or past the admit limit, is a conflict: the earlier scan stays canonical and the later row gets `conflict = true`. Because the hub also pulls the VM's scans, hub and VM end on the same answer.
- The hub and the VM stamp rows with their own clocks, so a phone keeps one cursor for each and never sends one to the other.

## 10. Troubleshooting

| Symptom                                              | Check                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/api/health` answers 500                            | The `migrate` container did not finish: `docker compose -f docker/compose.hub.yml logs migrate`.                                                                               |
| `{"error":{"code":"hub_not_linked"...}}` on enrolment | Section 3 was not done (or the volume was wiped).                                                                                                                              |
| `last_cloud_sync_at` is old, worker logs `retrying`  | Uplink or VM problem. `curl -s https://tickets.example.org/api/health` from the hub. A `refused` message with 401 means the VM revoked this hub's credential.                  |
| Phone shows **Cloud-only**                           | The phone cannot reach `hub.example.org` within 800 ms: DNS override (section 5), certificate, signal at that gate, or the hub is down.                                         |
| "Set up" fails with "setup code is invalid"          | The code was used, has expired (10 minutes), or the hub has not pulled it yet (wait 30 s).                                                                                       |
| Phone browser warns about the certificate            | Expired (section 4) or the phone resolved `hub.example.org` through public DNS to the wrong address.                                                                            |
| Tickets generated a moment ago say "not found"       | The hub could not reach the VM to ask. It arrives with the next successful pull.                                                                                               |
| Hub log: `database is locked`                        | Another process holds a long write on `hub.sqlite`; the app and worker wait up to 5 s each. Do not open the file with other tools during the event.                            |
