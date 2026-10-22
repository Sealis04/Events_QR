# Deploying the server on the VM

The VM runs three containers from `docker/compose.vm.yml`: `app` (Next.js, server mode), `worker` (email queue) and `mariadb`. A one-shot `migrate` container applies the database migrations before the app and worker start. Nginx Proxy Manager (NPM) terminates TLS in front of the app. Nothing here needs a cloud service.

## 1. What you need

- A Linux VM with Docker and the Compose plugin.
- A domain on Cloudflare, for example `tickets.example.org`.
- Nginx Proxy Manager, on this VM or another machine, with ports 80 and 443 forwarded from your router.
- For email: a Google Workspace service account with domain-wide delegation (section 6).

## 2. Configuration (`.env`)

Copy the template and fill it in. The file is read by Compose (`--env-file .env`) and by the app and worker containers. It is gitignored; never commit it.

```bash
cp .env.demo .env
```

| Variable                          | What to put there                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_NAME`, `DB_USER`              | Database name and user (defaults `events_qr`).                                                                                                                          |
| `DB_PASSWORD`, `DB_ROOT_PASSWORD` | Long random passwords: `openssl rand -hex 24`. The root password is only used when MariaDB first initialises its volume.                                                |
| `SESSION_SECRET`                  | 32+ random characters (`openssl rand -hex 32`). Signs the staff session cookie. Changing it logs everyone out.                                                          |
| `EVENT_KEY_MASTER`                | 64 hex characters (`openssl rand -hex 32`). Encrypts every event's AES key inside MariaDB. **Losing it makes every issued ticket unreadable**: back it up (section 7). |
| `SIGNING_KEY_PASSPHRASE`          | Passphrase for the Ed25519 signing key file (`openssl rand -hex 24`).                                                                                                   |
| `SECRETS_DIR`                     | Host folder holding `signing-key.json` and `gmail-sa.json`, mounted at `/secrets` (read-only for the app; the worker may rewrite `signing-key.json`). Default: the repo's `.secrets` folder.            |
| `HUB_URL`                         | Optional. Address printed into `DEV1:` setup QRs. Leave unset until the hub exists (M4); the app then uses its own address.                                             |
| `EVENT_TIMEZONE`                  | IANA zone used for "00:00 local on the first day" (time-slot minutes), unless an event sets its own `timezone`. Example `Asia/Manila`.                                  |
| `GMAIL_SENDER`                    | The Workspace mailbox tickets are sent from.                                                                                                                            |
| `EMAIL_DAILY_LIMIT`               | Max emails per rolling 24 hours (default 1800, under Gmail's 2,000).                                                                                                    |
| `APP_BIND`, `APP_PORT`            | Where the app listens on the host. Default `127.0.0.1:3000`; use `APP_BIND=0.0.0.0` if NPM runs on another machine.                                                     |

Delete the `COOKIE_SECURE=false` line from `.env` for production. The compose file forces `COOKIE_SECURE=true` for the app anyway, because browsers must only send the session cookie over HTTPS. The `false` in `.env.demo` is for `bun dev` over plain `http://localhost`.

## 3. Create the keys

The signing key never leaves the VM and is only read by `apps/web/src/server/signing.ts`.

```bash
mkdir -p .secrets && chmod 700 .secrets
docker compose --env-file .env -f docker/compose.vm.yml run --rm tools bun scripts/gen-signing-key.ts
```

This writes `.secrets/signing-key.json`: the Ed25519 secret key encrypted with `SIGNING_KEY_PASSPHRASE`, plus its public key. It refuses to overwrite an existing file.

**Rotation.** `bun scripts/gen-signing-key.ts --rotate` adds a new generation (`key_id` 2, 3, and so on) and makes it current for _new events_. Existing events keep signing with their own generation, so re-sent tickets stay byte-identical, and every public key stays valid for verification. After a suspected compromise, rotate, then drop the old secret with `--retire <id>` and re-issue the affected tickets (transfer, or cancel and generate again). **Automatic clean-up.** The worker (on start and every hour) deletes the secret of every non-current key generation once no event signed with it has an end time in the future; the public key stays, so issued tickets keep verifying. After that, re-sending a ticket of such an event answers `409 signing_key_retired`. The key id is one byte, so there are at most 255 generations.

For Gmail, put the service-account JSON at `.secrets/gmail-sa.json` (section 6).

## 4. Start the stack and create the first admin

```bash
docker compose --env-file .env -f docker/compose.vm.yml up -d --build
docker compose --env-file .env -f docker/compose.vm.yml run --rm tools bun scripts/create-admin.ts --name "Alex"
```

The second command asks for a PIN (6+ characters) and stores it hashed with argon2id. Use `--role supervisor` or `--role staff` for other accounts, or create them from the app as an admin (`POST /api/staff`).

Check it is up:

```bash
curl -s http://127.0.0.1:3000/api/health      # {"ok":true,"mode":"server",...}
docker compose -f docker/compose.vm.yml logs -f app worker
```

Open the app, log in, create an event, add ticket types, and generate a ticket.

## 5. Nginx Proxy Manager and Cloudflare

**Cloudflare DNS.** Add an `A` record `tickets` pointing to the public IP that forwards ports 80 and 443 to NPM. The proxied (orange cloud) setting works for the app; set SSL/TLS mode to **Full (strict)**. (The venue hub in M4 uses a DNS-only record instead.)

**NPM proxy host** (Hosts → Proxy Hosts → Add):

- Domain Names: `tickets.example.org`
- Scheme `http`, Forward Hostname/IP: `127.0.0.1` if NPM shares the VM's host network, otherwise the VM's LAN IP (which needs `APP_BIND=0.0.0.0`) or a shared Docker network. Forward Port `3000`.
- Block Common Exploits: on. Websockets: not needed.
- SSL tab: request a Let's Encrypt certificate (the DNS challenge with a Cloudflare API token limited to DNS edit on the zone works with the proxied record), enable Force SSL and HTTP/2.
- Advanced tab, so CSV imports of a few thousand rows fit:
  ```
  client_max_body_size 8m;
  ```
  NPM already forwards `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`. The app uses them for the setup-QR address, the login rate limit and its same-origin check.

MariaDB is not published to the host by this compose file. If the firewall allows it, also keep port 3000 reachable only from NPM.

## 6. Email through Gmail

1. In Google Cloud, create a service account, enable the **Gmail API**, and download its JSON key to `.secrets/gmail-sa.json`.
2. In the Workspace Admin console (Security → API controls → Domain-wide delegation) add the service account's client ID with the scope `https://www.googleapis.com/auth/gmail.send`.
3. Set `GMAIL_SENDER` to the mailbox the tickets should come from (the service account impersonates it).

The worker (`apps/worker`) sends queued emails through the Gmail API, at most `EMAIL_DAILY_LIMIT` per rolling 24 hours, spaced by `EMAIL_MIN_INTERVAL_MS`. A failed send is retried with backoff (30 s, 1 min, 2 min, and so on up to an hour) and marked `failed` after `EMAIL_MAX_ATTEMPTS` or a permanent error. Delivery status lives in the `email_queue` table (`status`, `attempts`, `last_error`, `sent_at`).

The worker needs both `GMAIL_SA_KEY_PATH` and `GMAIL_SENDER`; without them it exits at start-up and the queue just waits.

## 7. Backups

Back up three things. Missing any one makes a restore impossible or useless.

1. **The database** (tickets, scans, staff, encrypted event keys). Nightly, from cron on the VM:
   ```bash
   docker compose -f docker/compose.vm.yml exec -T mariadb \
     sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines events_qr' \
     | gzip > /backups/events_qr-$(date +%F).sql.gz
   ```
   Keep at least 14 days and copy them off the VM. Restore with `gunzip -c file.sql.gz | docker compose -f docker/compose.vm.yml exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" events_qr'`. Test a restore before the first event.
2. **The signing key file** `.secrets/signing-key.json`, **and its passphrase**. Store the passphrase somewhere other than the file, for example in a password manager. Without the key you can no longer re-send an existing ticket; without the passphrase you cannot read the key.
3. **`.env`**, in particular `EVENT_KEY_MASTER`. The database holds each event's AES key only in encrypted form; without the master key the dump cannot decrypt any ticket.

Do not keep the key file, its passphrase and the database dump together in one unencrypted place.

## 8. Operations

- **Update:** `git pull`, then `docker compose --env-file .env -f docker/compose.vm.yml up -d --build`. The `migrate` container runs new migrations first.
- **Logs:** `docker compose -f docker/compose.vm.yml logs -f app worker`.
- **Stuck emails:** `SELECT id, to_email, status, attempts, last_error FROM email_queue WHERE status <> 'sent' ORDER BY id DESC LIMIT 50;`
- **Staff PIN reset:** there is no self-service reset in v1. An admin can add the person again under a new name.
- The app and worker run as a single instance each. The login rate limiter lives in memory, so restarting the app clears it.
