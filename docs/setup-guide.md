# Setup guide: from an empty VM to a first event

For the IT person doing the first install. Follow it top to bottom. Every step ends with a **Check** (a command or something you should see) and an **If it fails** line; do not go on until the check passes. It can be followed on its own; the deeper references are [`docs/deploy-vm.md`](deploy-vm.md), [`docs/deploy-hub.md`](deploy-hub.md), the event-day [`docs/runbook.md`](runbook.md) and the rehearsal [`docs/field-test.md`](field-test.md).

**What you are building**

```text
 phones ──Wi-Fi──▶ hub (venue, SQLite) ◀──worker──▶ VM (office/cloud, MariaDB) ──▶ Gmail
 phones ───────────────────────────────────────────▶ VM        only if the hub does not answer in 800 ms
```

- The **VM** makes the tickets (it alone holds the signing key), keeps the master copy of everything and sends the emails. People reach it at `https://tickets.example.org` through Nginx Proxy Manager (NPM).
- The **hub** is a small box at the venue. During the event it decides "has this ticket been used", with or without internet, at `https://hub.example.org`. It can verify and claim tickets but can never make one.
- **Phones** run the scanner page (`/scan`), ask the hub first, then the VM, and decide alone from their own copy of the ticket list when neither answers.

Throughout, replace `tickets.example.org`, `hub.example.org` and the hub's LAN address `192.168.50.10` with your own. Commands marked "on the VM" run in the repository folder (`events-qr`) on the VM; commands marked "on the hub" run in the repository folder on the hub.

---

## 0. Prerequisites

Tick every box before you start. Each is something you cannot fix from the keyboard halfway through.

- [ ] **VM**: Linux (Ubuntu Server 24.04 LTS or Debian 12 tested), 2 vCPU, 4 GB RAM, 20 GB disk, a public IP or a router that can forward ports 80 and 443 to it, and a working clock (NTP is on by default). You have `sudo`.
- [ ] **Domain on Cloudflare**: you can edit its DNS records and create an API token (My Profile → API Tokens). Two names will be used: `tickets.<domain>` (the VM) and `hub.<domain>` (the hub).
- [ ] **Google Workspace admin access** (Admin console, Security → API controls) and a Google Cloud project you can create a service account in. A plain `@gmail.com` account cannot do domain-wide delegation. You also have a mailbox to send tickets from, for example `tickets@example.org`.
- [ ] **Hub hardware**: a mini PC or Raspberry Pi 5 (4 GB RAM) with an **SSD** (not an SD card), a small **UPS**, an Ethernet cable; a **router** you control at the venue with its own SSID, and an access point per gate if gates are more than about 30 m apart. You can give the hub a fixed LAN address (a DHCP reservation).
- [ ] **A second hub** (same hardware) as a standby. Optional but strongly recommended.
- [ ] **Phones**: one per gate and role, with a current Chrome (Android) or Safari (iPhone), a working camera, and enough battery for the whole event.
- [ ] The **repository address** (`git clone` URL) and your own **password manager** for the secrets below.
- [ ] A computer or phone of your own to test with.

**Check:** you can answer "yes" to each box above.
**If it fails:** stop and get the missing item first; every later step depends on it.

---

## 1. The VM

### 1.1 Install Docker

On the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
```

Log out and in again so the group applies.

**Check:** `docker compose version` prints a version, and `docker run --rm hello-world` prints "Hello from Docker!".
**If it fails:** `permission denied ... docker.sock` means you did not log out and in after `usermod`; anything else, use Docker's own install guide for your distribution (<https://docs.docker.com/engine/install/>) and install the Compose plugin.

### 1.2 Get the code

```bash
git clone https://github.com/sealis04/events_qr.git events-qr
cd events-qr
```

**Check:** `ls docker/compose.vm.yml .env.demo` lists both files.
**If it fails:** `Repository not found` means you need access or credentials for the repository (ask whoever gave you the address).

### 1.3 Fill in `.env`

The stack reads its settings from `.env` in the repository folder. It is gitignored: never commit it.

```bash
cp .env.demo .env
chmod 600 .env
fill() { sed -i "s|^$1=.*|$1=$2|" .env; }
fill DB_PASSWORD "$(openssl rand -hex 24)"
fill DB_ROOT_PASSWORD "$(openssl rand -hex 24)"
fill SESSION_SECRET "$(openssl rand -hex 32)"
fill EVENT_KEY_MASTER "$(openssl rand -hex 32)"
fill SIGNING_KEY_PASSPHRASE "$(openssl rand -hex 24)"
fill EVENT_TIMEZONE "Asia/Manila"
sed -i '/^COOKIE_SECURE=/d' .env
echo 'APP_PORT=3001' >> .env
sed -i 's|^# PUBLIC_URL=.*|PUBLIC_URL=https://tickets.example.org|' .env
```

Use your own time zone name (an IANA name such as `Europe/Berlin`) and your own address in `PUBLIC_URL`. Leave `HUB_URL` commented out for now (section 4 sets it).

What each variable means, and whether it is a secret:

| Variable                                   | Secret? | What it is                                                                                                                                                                                               |
| ------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_MODE`                                 | no      | `server` in `.env.demo`. The compose file sets the right mode for each container; leave it.                                                                                                              |
| `DB_HOST`, `DB_PORT`                       | no      | Used only when you run scripts outside Docker. The containers always use the `mariadb` container. Leave.                                                                                                 |
| `DB_NAME`, `DB_USER`                       | no      | Database name and user (`events_qr`).                                                                                                                                                                    |
| `DB_PASSWORD`                              | **yes** | The app's database password. Only read when MariaDB first creates its volume: changing it later also needs `ALTER USER` (section 7).                                                                     |
| `DB_ROOT_PASSWORD`                         | **yes** | MariaDB root password; used by the backup command.                                                                                                                                                       |
| `SESSION_SECRET`                           | **yes** | Signs the staff login cookie. Changing it logs everyone out.                                                                                                                                             |
| `EVENT_KEY_MASTER`                         | **yes** | 64 hex characters. Encrypts every event's AES key inside the database. **Losing it makes every issued ticket unreadable.** Back it up (step 1.4).                                                        |
| `SIGNING_KEY_PATH`                         | no      | Where the signing key file is. The compose file points it at `/secrets/signing-key.json`; leave it.                                                                                                      |
| `SIGNING_KEY_PASSPHRASE`                   | **yes** | Passphrase of the signing key file. Keep it somewhere other than the file.                                                                                                                               |
| `COOKIE_SECURE`                            | no      | Deleted above: the compose file forces secure cookies. (`false` is only for plain-http development.)                                                                                                     |
| `PUBLIC_URL`                               | no      | The VM's own address. Phones and hubs keep it as the fallback "cloud" address.                                                                                                                           |
| `HUB_URL`                                  | no      | The hub's address, printed into the setup QR so phones ask the hub first (step 4.2).                                                                                                                     |
| `EVENT_TIMEZONE`                           | no      | Zone used for "00:00 local on the first day" (time slots), unless an event sets its own.                                                                                                                 |
| `GMAIL_SA_KEY_PATH`, `GMAIL_SENDER`        | no\*    | The Gmail setup of section 3. (\*The key _file_ is a secret; these two lines are not.) The compose file sets the path to `/secrets/gmail-sa.json`.                                                      |
| `EMAIL_DAILY_LIMIT`                        | no      | Emails per rolling 24 hours (default 1800, under Gmail's 2,000).                                                                                                                                         |
| `RETENTION_*`                              | no      | The nightly privacy job: names and emails are cleared `RETENTION_PII_DAYS` (365) after an event ends, scans deleted after `RETENTION_SCANS_DAYS` (1095). Defaults are fine; `RETENTION_DRY_RUN=true` only logs. |
| `APP_BIND`, `APP_PORT`                     | no      | Where the app listens on the host. This guide uses `127.0.0.1:3001` (the default port 3000 is taken by NPM itself, step 2.1); the `.env` lines below set it. Use `APP_BIND=0.0.0.0` only if NPM runs on another machine (not in this guide).                                                          |
| `SECRETS_DIR`                              | no      | Host folder with the key files, mounted at `/secrets`. Default `.secrets` in the repository folder.                                                                                                      |
| `HUB_DB_PATH`, `HUB_*_SECONDS`             | no      | Hub-only settings; ignore on the VM.                                                                                                                                                                     |

**Check:**

```bash
grep -cE '^(DB_PASSWORD|DB_ROOT_PASSWORD|SESSION_SECRET|EVENT_KEY_MASTER|SIGNING_KEY_PASSPHRASE)=.+' .env
docker compose --env-file .env -f docker/compose.vm.yml config --quiet && echo compose-ok
```

prints `5`, then `compose-ok`.
**If it fails:** a count below 5 means a variable is still empty: re-run its `fill` line. `compose` complaining `set DB_PASSWORD in .env` means the same; a YAML error means the compose file was edited.

### 1.4 Put the secrets somewhere safe now

Copy `.env` into your password manager or an encrypted vault (it holds `EVENT_KEY_MASTER`, the passphrase and the database passwords). You will back up the signing key file after step 1.5. Do not keep them all in one unencrypted place.

**Check:** you can open the stored copy and see `EVENT_KEY_MASTER=` followed by 64 characters.
**If it fails:** do not go on. A VM that is lost with the only copy of `EVENT_KEY_MASTER` takes every issued ticket with it.

### 1.5 Create the signing key

The signing key makes tickets. It never leaves the VM.

```bash
mkdir -p .secrets && sudo chown 1000:1000 .secrets && chmod 700 .secrets
docker compose --env-file .env -f docker/compose.vm.yml run --rm tools bun scripts/gen-signing-key.ts
```

The `.secrets` folder belongs to user id 1000 because the containers (the app, the worker and `tools`) run as that user, whatever your own user id is; that is why the `ls` and `cp` commands on it below need `sudo`. The first run builds the image (a few minutes). Then copy the key to your vault too (it is encrypted with the passphrase): `sudo cp .secrets/signing-key.json ~/signing-key.json && sudo chown "$USER" ~/signing-key.json`.

**Check:** `sudo ls -ln .secrets/signing-key.json` shows the file owned by `1000 1000`, and the script printed `wrote ... with key 1 (public ...)`.
**If it fails:** `refuses to overwrite` means a key already exists (keep it). `EACCES` / `permission denied` means `.secrets` is not owned by 1000 (run the `chown` above). A build error mentioning the network means the VM cannot reach Docker Hub or npm: fix DNS/proxy and re-run.

### 1.6 Start the stack (without the email worker yet)

```bash
docker compose --env-file .env -f docker/compose.vm.yml up -d --build app
```

This starts MariaDB, runs the database migrations, then starts the app. The email worker is started in section 3: it exits at start-up until Gmail is configured.

**Check:**

```bash
docker compose --env-file .env -f docker/compose.vm.yml ps
curl -s http://127.0.0.1:3001/api/health
```

`mariadb` and `app` are `running`/`healthy` (`migrate` shows `exited (0)`), and the second command prints `{"ok":true,"mode":"server",...}`.
**If it fails:** `docker compose --env-file .env -f docker/compose.vm.yml logs migrate app`. Migration errors: see the troubleshooting table ("migrations fail").

### 1.7 Create the first admin

```bash
docker compose --env-file .env -f docker/compose.vm.yml run --rm tools bun scripts/create-admin.ts --name "Alex"
```

It asks for a PIN. **Admins and supervisors need 8 or more digits; staff need 6 or more characters.** (To script it, `-e PIN=...` works but lands in shell history.)

**Check:** the script prints `created admin "Alex" (<id>)`, and this prints `200`:

```bash
read -rsp "PIN: " PIN; echo
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3001/api/auth/login \
  -H 'content-type: application/json' -d "{\"name\":\"Alex\",\"pin\":\"$PIN\"}"
```

**If it fails:** a PIN shorter than 8 digits is refused for an admin (choose a longer one). `401` from the curl is a wrong name or PIN (names are matched case-insensitively). `500` means the database is not ready: check step 1.6.

### 1.8 Back up the database, the key file and `.env`

Three things, and a restore is impossible without all of them:

1. The **database**. Create the folder and a nightly job (from the user that runs Docker):
   ```bash
   sudo mkdir -p /backups && sudo chown "$USER" /backups
   cat > /tmp/events-qr-backup <<EOF
   cd $PWD && docker compose --env-file .env -f docker/compose.vm.yml exec -T mariadb sh -c 'mariadb-dump -uroot -p"\$MARIADB_ROOT_PASSWORD" --single-transaction --routines events_qr' | gzip > /backups/events_qr-\$(date +%F).sql.gz
   EOF
   sudo install -m 755 /tmp/events-qr-backup /usr/local/bin/events-qr-backup
   sudo apt install -y cron   # only if `crontab` is missing
   (crontab -l 2>/dev/null; echo '15 2 * * * /usr/local/bin/events-qr-backup') | crontab -
   /usr/local/bin/events-qr-backup
   ```
   Keep 14 days, and copy the files off the VM (another machine, object storage).
2. `.secrets/signing-key.json` (copy it with `sudo`, step 1.5) **and its passphrase**.
3. `.env` (especially `EVENT_KEY_MASTER`).

**Check:** `ls -l /backups` shows an `events_qr-<today>.sql.gz` (not empty), `gunzip -c /backups/events_qr-*.sql.gz | head -5` shows a `-- MariaDB dump` line, and `crontab -l` lists the `events-qr-backup` line.
**If it fails:** `mariadb-dump: Got error ... Access denied` means `DB_ROOT_PASSWORD` in `.env` is not the one MariaDB was created with (changed after first start; see section 7); an empty file means the `exec` failed: run the `docker compose ... exec` part by hand to see the error. Before the first event, also try a restore into a scratch database (`docs/deploy-vm.md` section 7).

---

## 2. Nginx Proxy Manager, certificate, port forward and Cloudflare

The app listens on `127.0.0.1:3001` only (`APP_PORT` in `.env`). NPM puts HTTPS in front of it.

### 2.1 Run Nginx Proxy Manager

On the VM:

```bash
docker run -d --name npm --restart unless-stopped --network host \
  -v npm-data:/data -v npm-letsencrypt:/etc/letsencrypt \
  jc21/nginx-proxy-manager:2.12.3
```

`--network host` lets NPM forward to `127.0.0.1:3001`. (NPM's own backend uses port 3000 on the host, which is why the app is on 3001: two programs cannot both listen on 3000.) Open `http://<VM address>:81` from your own computer; first login `admin@example.com` / `changeme`, and it makes you change both at once.

**Check:** `curl -sI http://127.0.0.1:81 | head -1` prints `HTTP/1.1 200 OK` and the NPM login page opens.
**If it fails:** `address already in use` (see `docker logs npm`) means something else holds port 80, 81, 443 or 3000 on this VM (`sudo ss -ltnp | grep -E ':(80|81|443|3000) '`): stop it, remove the container (`docker rm -f npm`) and run the command again. `socket() [::]:80 failed` in the log means this VM has IPv6 switched off: remove the container and add `-e DISABLE_IPV6=true` to the `docker run` line.

### 2.2 Cloudflare DNS record for the app

In Cloudflare → DNS, add an `A` record named `tickets` pointing at the public IP that forwards ports 80 and 443 to this VM. Proxied (orange cloud) is fine for the app. Under SSL/TLS set the mode to **Full (strict)**.

Create an API token limited to **Zone → DNS → Edit** on this one zone (My Profile → API Tokens → Create Token, template "Edit zone DNS"). Keep it in your password manager. It is typed into NPM only; it never goes into the repository or `.env`.

**Check:** `dig +short tickets.example.org @1.1.1.1` prints an address (with the orange cloud it is a Cloudflare address, not yours).
**If it fails:** wait a minute and retry; check the record name and zone.

### 2.3 Forward ports 80 and 443 on your router

On the router (or cloud firewall) forward TCP 80 and 443 to the VM, and allow them through the VM's firewall (`sudo ufw allow 80,443/tcp` if `ufw` is on). Port 81 stays closed to the internet; keep it reachable only from your own network. Do not forward 3000.

**Check:** from outside your network (a phone on mobile data) `http://tickets.example.org` shows the NPM "Congratulations, your website is up" page.
**If it fails:** the forward points at the wrong address, the ISP blocks port 80 (ask for a different plan or use the DNS challenge only and a cloud VM), or the Cloudflare record is wrong.

### 2.4 Proxy host and certificate

In NPM:

1. **SSL Certificates → Add SSL Certificate → Let's Encrypt**: domain `tickets.example.org`, turn on **Use a DNS Challenge**, provider **Cloudflare**, credentials `dns_cloudflare_api_token = <your token>`, accept the terms, **Save**. NPM renews it on its own.
2. **Hosts → Proxy Hosts → Add Proxy Host**: Domain Names `tickets.example.org`; Scheme `http`; Forward Hostname/IP `127.0.0.1`; Forward Port `3001`; **Block Common Exploits** on. SSL tab: pick the certificate, **Force SSL** and **HTTP/2** on. Advanced tab, so CSV imports of a few thousand rows fit:
   ```
   client_max_body_size 8m;
   ```
   Save. NPM already forwards `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`; the app uses them for the setup-QR address, the login rate limit and its same-origin check.

**Check:** `curl -s https://tickets.example.org/api/health` prints `{"ok":true,"mode":"server",...}`, and a browser shows the login page with a padlock.
**If it fails:** `502` means NPM cannot reach `127.0.0.1:3001` (the container is not on the host network, or the app is down: re-do step 2.1 / 1.6). `522`/timeout from Cloudflare means ports 80/443 are not forwarded (step 2.3). A certificate error from Cloudflare means the SSL mode is not **Full (strict)** or the certificate was not attached to the host.

### 2.5 Log in

Open `https://tickets.example.org`, log in as the admin from step 1.7, and change nothing yet.

**Check:** the page shows "Events" and your name with `(admin)`, and the pill reads `VM`.
**If it fails:** `bad_origin`/cookie problems mean the proxy does not forward `Host`/`X-Forwarded-Proto` (use NPM as above) or `PUBLIC_URL` is wrong.

---

## 3. Gmail

Tickets are emailed through the Gmail API, as a mailbox in your Workspace, by a service account that is allowed to impersonate it.

### 3.1 Create the service account and key

1. In Google Cloud (<https://console.cloud.google.com>) pick or create a project. **APIs & Services → Library → Gmail API → Enable**.
2. **IAM & Admin → Service Accounts → Create service account** (any name, for example `events-qr-mailer`; no project roles needed).
3. Open the account → **Keys → Add key → Create new key → JSON**. Your browser downloads a file. Note the account's **Unique ID** (a long number, also called the client ID) on its Details tab.
4. Copy the file to the VM as `.secrets/gmail-sa.json`, owned by user 1000 like the rest of that folder, and locked down (replace the first path with where the download landed):
   ```bash
   sudo install -o 1000 -g 1000 -m 600 ~/Downloads/<downloaded file>.json .secrets/gmail-sa.json
   ```

**Check:** `sudo grep -c '"client_email"' .secrets/gmail-sa.json` prints `1`.
**If it fails:** the file is not the JSON key (a P12 download or a web page): create the key again as JSON. Your organisation may block key creation (policy `iam.disableServiceAccountKeyCreation`): ask a Google Cloud admin to lift it for this project.

### 3.2 Allow the service account to send as your sender (domain-wide delegation)

In the Workspace **Admin console → Security → Access and data control → API controls → Manage Domain Wide Delegation → Add new**: Client ID = the service account's Unique ID from step 3.1, OAuth scope:

```
https://www.googleapis.com/auth/gmail.send
```

**Check:** the new row appears in the delegation list with exactly that scope.
**If it fails:** you need Super Admin rights, or ask your Workspace admin to add the line. A wrong scope (extra spaces, `gmail.readonly`) makes step 3.4 fail with 403.

### 3.3 Tell the worker who the sender is, and start it

```bash
sed -i 's|^# GMAIL_SA_KEY_PATH=.*|GMAIL_SA_KEY_PATH=.secrets/gmail-sa.json|; s|^# GMAIL_SENDER=.*|GMAIL_SENDER=tickets@example.org|' .env
docker compose --env-file .env -f docker/compose.vm.yml up -d worker
```

Put your own mailbox in `GMAIL_SENDER`. (The compose file mounts the key at `/secrets/gmail-sa.json` inside the container; the path in `.env` is only for scripts run outside Docker.)

**Check:** `docker compose --env-file .env -f docker/compose.vm.yml logs --tail 5 worker` ends with `worker: sending as tickets@example.org, up to 1800 emails per 24 h` and the container stays `running` in `docker compose ... ps`.
**If it fails:** `GMAIL_SA_KEY_PATH and GMAIL_SENDER must be set` means the `sed` lines did not match (open `.env` and set both by hand), then re-run `up -d worker`.

### 3.4 Send a test email

In the dashboard: create the event of step 5.1 first if there is none (a ticket needs an event), open it → **QR generator**, make one ticket with **your own address** in the Email box and press **Generate**. You should see "Email queued to …".

**Check:** within a minute your mailbox has the ticket email, and

```bash
docker compose --env-file .env -f docker/compose.vm.yml exec -T mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" events_qr -e "SELECT id, to_email, status, attempts, last_error FROM email_queue ORDER BY id DESC LIMIT 3"'
```

shows `status` `sent`.
**If it fails:** read `last_error`. `403`/`unauthorized_client`/`delegation` means steps 3.1-3.2 (see the troubleshooting table); `status` stuck on `pending` with no worker log line means the worker is not running (step 3.3).

---

## 4. The venue hub

### 4.1 Install the operating system and Docker

On the hub machine install Ubuntu Server 24.04 LTS (64-bit; Raspberry Pi OS Lite 64-bit also works on a Pi 5), onto the SSD, wired to the venue router. Give it a **fixed LAN address** with a DHCP reservation on the router (this guide uses `192.168.50.10`), then install Docker as in step 1.1 (on the hub).

Make sure its clock is right, because phones correct their own clocks against the hub's:

```bash
timedatectl status
```

**Check:** `System clock synchronized: yes`, `docker compose version` works, and `ip -4 addr` shows `192.168.50.10`.
**If it fails:** `sudo timedatectl set-ntp true` (and `sudo apt install -y chrony` if NTP is missing); a wrong address means fix the reservation on the router and `sudo netplan apply`/reboot.

### 4.2 Tell the VM about the hub, and get the code

On the **VM**, set the hub's address in `.env` and recreate the app, so every setup QR carries it:

```bash
sed -i 's|^# HUB_URL=.*|HUB_URL=https://hub.example.org|' .env
docker compose --env-file .env -f docker/compose.vm.yml up -d app
```

Then make the one-time hub setup code (valid 10 minutes), as an admin or supervisor. Use the event's number from step 5.1 (`1` for the first event) — so do step 5.1 first if you have no event yet, then come back:

```bash
read -rsp "PIN: " PIN; echo
curl -s -c jar -X POST https://tickets.example.org/api/auth/login \
  -H 'content-type: application/json' -d "{\"name\":\"Alex\",\"pin\":\"$PIN\"}"
curl -s -b jar -X POST https://tickets.example.org/api/hubs/setup \
  -H 'content-type: application/json' -d '{"event_id":1,"label":"main hub"}'
# {"setup_code":"...","expires_at":...}
rm -f jar
```

**Check:** the second `curl` prints `{"setup_code":"…","expires_at":…}`; copy the code. `curl -s http://127.0.0.1:3001/api/health` still says `ok`.
**If it fails:** `401` is a wrong PIN; `403 forbidden` means the account is not a supervisor or admin; `404` means there is no event with that number (step 5.1).

### 4.3 Start the hub and bind it to the event

On the **hub**:

```bash
git clone https://github.com/sealis04/events_qr.git events-qr
cd events-qr
docker compose -f docker/compose.hub.yml up -d --build
curl -s http://127.0.0.1:3000/api/health
docker compose -f docker/compose.hub.yml run --rm tools \
  bun scripts/hub-enroll.ts https://tickets.example.org <setup code>
```

No `.env` is needed on the hub. Paste the setup code from step 4.2 (it is only valid for 10 minutes).

**Check:** the first health call prints `{"ok":true,"mode":"hub","last_cloud_sync_at":null,"pending_scans":0}`; `hub-enroll` prints `hub linked to https://tickets.example.org for event 1: <n> tickets, <n> scans`; and `curl -s http://127.0.0.1:3000/api/health` now shows a recent number in `last_cloud_sync_at` (within a minute; the worker pulls every 30 s).
**If it fails:** `hub_not_linked` is shown until `hub-enroll` succeeds. `setup code is invalid` means it expired or was used (make a new one). A network error means the hub cannot reach `https://tickets.example.org`: check DNS and the clock. A build error on a Pi means too little memory: add swap (`sudo fallocate -l 2G /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`).

### 4.4 Cloudflare record for the hub: DNS only

In Cloudflare → DNS add an `A` record `hub` → the hub's **LAN address** `192.168.50.10`, with the proxy **off (grey cloud, "DNS only")**. A private address in public DNS is fine: only phones on the venue network can use it. A proxied record would send phones to Cloudflare instead of the hub.

**Check:** `dig +short hub.example.org @1.1.1.1` prints exactly `192.168.50.10`.
**If it fails:** a Cloudflare address in the answer means the orange cloud is still on: click it so it turns grey. Nothing at all: wait a minute and check the name.

### 4.5 HTTPS on the hub: certificate by DNS-01, and renewal

Phones need HTTPS to install the scanner and use the camera. The certificate is proven with a Cloudflare DNS record, so the hub never has to be reachable from the internet. On the **hub**:

```bash
docker compose -f docker/compose.hub.yml --profile proxy up -d proxy
```

Open `http://192.168.50.10:81` from a computer on the same network (first login `admin@example.com` / `changeme`; change it at once), then:

1. **SSL Certificates → Add SSL Certificate → Let's Encrypt**: domain `hub.example.org`, **Use a DNS Challenge** on, provider **Cloudflare**, credentials `dns_cloudflare_api_token = <your token>` (the token of step 2.2, or a second one limited to the same zone). Save. NPM renews the certificate on its own while the hub has internet.
2. **Hosts → Proxy Hosts → Add Proxy Host**: domain `hub.example.org`; scheme `http`; Forward Hostname `app`; Forward Port `3000`; Block Common Exploits on. SSL tab: the certificate, Force SSL, HTTP/2. Save.
3. Make HTTPS the only way in from the LAN: on the hub create `.env` with `HUB_BIND=127.0.0.1` and recreate the app: `echo HUB_BIND=127.0.0.1 > .env && docker compose --env-file .env -f docker/compose.hub.yml up -d app`.

**Renewal needs internet.** Certificates last 90 days and renew when 30 remain. The hub needs internet at least every ~60 days. Put it on a normal network a week before every event and look at the date:

```bash
echo | openssl s_client -connect hub.example.org:443 -servername hub.example.org 2>/dev/null | openssl x509 -noout -enddate
```

**Check:** from a computer on the same network (with the router override of step 4.6, or an `/etc/hosts` line `192.168.50.10 hub.example.org`), `curl -s https://hub.example.org/api/health` prints the `"mode":"hub"` JSON with no certificate error, and the `enddate` is in the future.
**If it fails:** certificate request errors (`Invalid API token`, `DNS problem`) mean the token is wrong or lacks Zone DNS Edit on this zone; `502` means the proxy host forwards to the wrong place (hostname must be `app` on the hub's compose network) or the app is down; a connection error means `HUB_BIND=127.0.0.1` was set before the proxy worked (remove it and recreate the app).

### 4.6 Make `hub.<domain>` resolve with no internet

Public DNS is not reachable when the uplink is down, and some routers refuse to hand out private addresses from public DNS ("DNS rebinding protection"). The venue network must answer the name itself. Pick one:

- **On the router** (OpenWrt: Network → DHCP and DNS → Hostnames, or an `address=/hub.example.org/192.168.50.10` line in dnsmasq; pfSense/OPNsense: Host Overrides; UniFi: Local DNS Records): `hub.example.org` → `192.168.50.10`.
- **Or dnsmasq on the hub**, if the router cannot. On the hub:
  ```bash
  HUB_DOMAIN=hub.example.org HUB_LAN_IP=192.168.50.10 docker compose -f docker/compose.hub.yml --profile dns up -d dns
  ```
  and set the router's DHCP to hand out `192.168.50.10` as the **only** DNS server. Everything but the hub's name is forwarded to `1.1.1.1` while the internet is up.

**Check:** with a phone on the venue Wi-Fi **and the uplink cable unplugged**, open `https://hub.example.org/api/health`. It shows the JSON with `"mode":"hub"` and a padlock. From a laptop: `nslookup hub.example.org <router address>` returns `192.168.50.10`.
**If it fails:** the phone may use "Private DNS"/secure DNS or a VPN that bypasses the router (turn it off for this Wi-Fi); a router that keeps handing out a public DNS server needs its DHCP DNS setting changed; access points with "client isolation" on stop phones reaching the hub (turn it off).

### 4.7 Standby hub

Repeat steps 4.1 and 4.3 on a second machine, with **its own** hub setup code from step 4.2 (each hub gets a separate credential). Do not run its proxy or put it on the venue network: **two hubs answering at once would each decide "first scan" alone.** To fail over, power the primary off, put the standby on the network with the primary's LAN address (or point the router override at its address), and use the same certificate (issue it the same way on the standby, or copy it from the primary). Phones need no change; they find the hub by name.

**Check:** on the standby `curl -s http://127.0.0.1:3000/api/health` shows a recent `last_cloud_sync_at`, and `docker compose -f docker/compose.hub.yml ps` shows `app` and `worker` running.
**If it fails:** as for step 4.3.

---

## 5. Your first event, end to end

Do this once with no real audience, with internet, ideally at the venue (or a table with the router and hub).

### 5.1 Create the event

In the VM dashboard (`https://tickets.example.org`, admin login): **New event** → name, venue, **Doors open**, **Ends**, **Time zone** (for example `Asia/Manila`), **Gates** (one line per gate; the order cannot change once tickets exist, new gates can only be added at the end), **Ticket types** (name, capacity, entry rule: Single entry / Unlimited re-entry / Up to N entries, gates, time slot). Press **Create event**.

**Check:** the event page opens with its name and the gates in the line under the title; the browser address ends in `/events/1` for the first event (that number is the event number for step 4.2).
**If it fails:** an error banner says what is wrong (for example an end time before the start).

### 5.2 Staff on the event

Open the event → **Setup** → **Staff on this event**. Everyone who will scan must show **Remove** (assigned). Add people with **Create and add** (name, role, PIN) or **Add** for accounts that exist. Supervisors and admins need 8+ digit PINs, staff 6+ characters; anyone with a shorter existing PIN is asked to choose a new one at their next login.

**Check:** your test supervisor and test staff member are listed as assigned with the right role.
**If it fails:** an admin can add people; supervisors cannot see the Setup tab.

### 5.3 Make a test ticket

Event → **QR generator** → pick a **Ticket type**, type a **Holder name** (for example "Test Person"), put your own address in **Email**, press **Generate**.

**Check:** "Ticket ready" shows a QR code, and "Email queued to …" (the email arrives within a few minutes).
**If it fails:** no "Email queued" means the Email box was empty or the worker is down (step 3.3); the QR still works.

### 5.4 Print the hub setup codes

Event → **Devices** → **Batch codes for the venue hub**: pick a **Gate** and **Role**, **How many** (10), **Make hub setup codes**, then press **Print / Save as PDF** at once: the codes are shown only this one time. Each works once and stays valid until the event ends. Keep the printouts with the hub. These let you set phones up at the venue with no internet.

**Check:** the page shows a grid of QR codes, and printing (or "Save as PDF") produces the same grid.
**If it fails:** the card is on the VM's Devices tab, not the hub's, and needs a supervisor or admin login.

### 5.5 Set up a phone

On the VM dashboard: event → **Devices** → **Add a scanner**: pick the **Gate**, the **Role**, a **Label** such as "Gate A – phone 1" → **Show setup QR** (works once, for 10 minutes). On the phone (on the venue Wi-Fi) open `https://hub.example.org/scan`, press **Set up for event**, allow the camera, scan the QR. Log in with the staff name and PIN.

**Check:** the phone shows `Gate A · Entry` (your gate and role), and the pill top right reads **Hub · 0 queued** in green. In the dashboard, **Devices** lists the phone as **Online**.
**If it fails:** a **Cloud-only** pill means the phone cannot reach the hub (see troubleshooting); "Setup code is invalid" means the code is older than 10 minutes or was already used; no camera means allow it in the browser's site settings.

### 5.6 Scan the test ticket

On the phone scan the QR from step 5.3 (show it on a laptop screen or print it).

**Check:** the screen turns green with the holder's name and `Entry 1 of 1`; scanning it again after a few seconds shows red `Already used` or `Already inside`. In the dashboard, **Live stats** shows 1 admitted.
**If it fails:** `Not in list` (amber) means the ticket was made after the phone's last sync (wait 10 s and try again); `Invalid / forged` or `Wrong event` means the QR belongs to another deployment or event.

### 5.7 Pull the internet cable and scan again

Make a second test ticket on the VM (step 5.3, a different name). On the hub dashboard (`https://hub.example.org`, supervisor login) press **Pull tickets now** and wait for `Pulled N changes from the VM`. Unplug the router's uplink cable (the hub and the phones stay on the Wi-Fi). Scan the second ticket.

**Check:** the phone is still green with a **Hub** pill; the hub health page (`https://hub.example.org/api/health`) still answers; plug the cable back in and within a minute `last_cloud_sync_at` is recent and `pending_scans` is `0`, and the VM's **Live stats** shows the second admit.
**If it fails:** an orange **Offline** pill with no hub means the phone does not reach the hub (step 4.6); `Pull tickets now` answering `VM not reachable` with the cable in means the hub has no internet.

Then run the full rehearsal in [`docs/field-test.md`](field-test.md) and print the runbook ([`docs/runbook.md`](runbook.md)) for the event team.

---

## 6. Upgrading to a new version

Do it between events, never on the day, and with each phone showing **0 queued**.

1. **Back up first** (step 1.8): run `/usr/local/bin/events-qr-backup`.
2. **Read what changes.** On the VM: `git fetch && git log --oneline HEAD..origin/main` and, for the phones, whether the on-phone store changes:
   ```bash
   git diff HEAD..origin/main -- apps/web/src/scanner/idbStore.ts | grep -n DB_VERSION
   ```
3. **VM first.** On the VM:
   ```bash
   git pull
   docker compose --env-file .env -f docker/compose.vm.yml up -d --build
   ```
   The `migrate` container applies new database migrations before the app and worker start.
4. **Then each hub**, with internet (the VM's sync API only gets bigger, so an old hub keeps working against a new VM, but not the other way round). On the hub:
   ```bash
   git pull
   docker compose -f docker/compose.hub.yml up -d --build
   ```
   Its own `migrate` container upgrades the SQLite file; tickets, staff and the event key stay.
5. **Phones.** A phone picks up the new page the next time it is online (reload `/scan`). If step 2 printed a `DB_VERSION` line (the phone's local store format changed), the browser drops the stored data when the new page loads: the phone shows the setup screen, and **any scan still queued on it is lost**. Upload first (check `0 queued`), then set the phone up again with a new code (step 5.5). Otherwise nothing to do.

**Check:** `curl -s https://tickets.example.org/api/health` and `curl -s https://hub.example.org/api/health` both answer `ok` on the new build; `docker compose --env-file .env -f docker/compose.vm.yml ps` shows no restarting container; one test scan (step 5.6) is green.
**If it fails:** `docker compose ... logs migrate` for a migration error; restore the backup from step 1 (`docs/deploy-vm.md` section 7) and check out the previous version (`git checkout <old commit>`) before trying again.

---

## 7. Rotating keys and secrets

| What                     | How                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Signing key**          | On the VM: `docker compose --env-file .env -f docker/compose.vm.yml run --rm tools bun scripts/gen-signing-key.ts --rotate`, then `docker compose --env-file .env -f docker/compose.vm.yml up -d --force-recreate app worker`. New events sign with the new generation; existing events keep their own, so re-sent tickets stay identical and every public key still verifies. |
| After a suspected leak   | Rotate as above, then `... run --rm tools bun scripts/gen-signing-key.ts --retire <old id>` (drops that generation's secret; its public key still verifies) and re-issue the affected tickets (transfer, or cancel and generate again). The worker also drops the secrets of old generations by itself once every event signed with them has ended.                              |
| `EVENT_KEY_MASTER`       | **There is no command to change it in v1.** It encrypts every event's key inside the database; a different value makes existing events unreadable. Treat it as permanent for the life of the database: keep it in two safe places and never edit it on a running system. If it leaks, plan a new deployment (new database, re-issue tickets).                                      |
| `SESSION_SECRET`         | Edit `.env`, then `docker compose --env-file .env -f docker/compose.vm.yml up -d --force-recreate app worker`. Everyone is logged out once.                                                                                                                                                                                                                                     |
| Database passwords       | `.env` only sets them when MariaDB first creates its volume. To change: `docker compose ... exec mariadb sh -c 'mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e "ALTER USER \"events_qr\"@\"%\" IDENTIFIED BY \"<new>\"; ALTER USER root@\"%\" IDENTIFIED BY \"<new root>\"; ALTER USER root@localhost IDENTIFIED BY \"<new root>\"; FLUSH PRIVILEGES"'`, then edit `.env` to match and recreate the app and worker. |
| A hub's credential       | Wipe the hub (`docker compose -f docker/compose.hub.yml down -v`), revoke its old credential on the VM (`docs/deploy-hub.md` section 8), make a new setup code (step 4.2) and enrol again (step 4.3).                                                                                                                                                                          |
| A lost phone             | Event → **Devices** → **Revoke and rotate**. Everyone tied to the event chooses a new PIN at their next login.                                                                                                                                                                                                                                                                  |

**Check (signing key):** `.secrets/signing-key.json` now lists a new `key_id`, a ticket made for a **new** event verifies at a phone (step 5.6), and a ticket re-sent for an older event still scans.
**If it fails:** `docker compose ... logs app` for `signing key` errors; restore `.secrets/signing-key.json` from your vault and recreate the app.

---

## Troubleshooting

| Symptom                                                                | Likely cause                                                                                                                                                                                  | Fix                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phones show a certificate warning for the hub                          | The certificate expired (the hub had no internet for 60+ days), or `hub.example.org` resolved to the wrong address, or the phone's clock is wrong.                                            | Put the hub on a normal network, renew in NPM (SSL Certificates → renew), check `openssl s_client ... -enddate` (step 4.5), fix the DNS override (step 4.6), set the phone's time automatically.                                                          |
| `hub.example.org` does not resolve with the uplink unplugged           | No local override: the name only exists in public DNS, which is unreachable; or the phone uses Private DNS/a VPN.                                                                             | Add the router override or run the `dns` profile (step 4.6); turn off Private DNS on the phones. Test with `nslookup hub.example.org <router>` with the cable out.                                                                                       |
| The `hub` record has the Cloudflare orange cloud on                    | The record is proxied, so it resolves to Cloudflare addresses, not `192.168.50.10`: phones off the local override reach nothing, and Cloudflare cannot proxy a private address.               | Turn the cloud grey (DNS only) in Cloudflare. `dig +short hub.example.org @1.1.1.1` must print `192.168.50.10`.                                                                                                                                          |
| Gmail `403`, `unauthorized_client`, "delegation denied" in the worker  | Domain-wide delegation is missing, has the wrong client ID or scope, or `GMAIL_SENDER` is not a mailbox in the Workspace.                                                                     | Redo step 3.2 with the service account's Unique ID and exactly `https://www.googleapis.com/auth/gmail.send`; wait a few minutes (delegation can take time to apply); check `GMAIL_SENDER`; `docker compose ... logs worker`.                              |
| Emails stop after about 1,800 ("throttled")                            | `EMAIL_DAILY_LIMIT` (rolling 24 hours, under Gmail's 2,000 per day).                                                                                                                          | Wait; queued mail goes out as the window moves. For bulk sends, issue tickets days ahead. Check the queue with the query in step 3.4. Do not raise the limit above your Workspace's own.                                                                  |
| Migrations fail (`migrate` exits non-zero, app never starts)           | MariaDB not ready, or `.env` passwords differ from the ones the data volume was created with (you edited `.env` after the first start).                                                       | `docker compose --env-file .env -f docker/compose.vm.yml logs migrate mariadb`. Put the original passwords back, or change them in the database too (section 7). On a brand-new install with nothing in it: `docker compose ... down -v` and start again. |
| A phone stays **Cloud-only**                                           | It cannot reach the hub within 800 ms: DNS (step 4.6), certificate, weak Wi-Fi or AP client isolation, hub down; or the setup QR had no hub address because `HUB_URL` was not set when it was made. | Check `https://hub.example.org/api/health` from the phone's browser. If `HUB_URL` was missing, set it (step 4.2), recreate the app, and set the phone up again with a new code (**Set up again**).                                                        |
| Clock drift between phone, hub and VM                                  | NTP is off on the hub or VM (a Pi has no battery clock), or a phone has a manual time. Symptoms: "Too early"/"Slot ended" at the wrong times, odd `scanned_at` in conflicts.                  | `timedatectl status` must say `System clock synchronized: yes` on VM and hub (`sudo timedatectl set-ntp true`, `chrony`); phones: automatic date and time. Phones correct themselves against the hub on each sync, so fix the hub first.                  |
| Worker or app cannot read or write the key files (`EACCES`, `signing-key.json`) | `.secrets` or a file in it is not owned by user id 1000, which is who the containers run as (created with `sudo`, as root, or by another user).                              | `sudo ls -ln .secrets`; then `sudo chown -R 1000:1000 .secrets && sudo chmod 700 .secrets && sudo chmod 600 .secrets/*`, and `docker compose --env-file .env -f docker/compose.vm.yml up -d --force-recreate app worker`.                                |
| A 6-digit PIN is refused for a supervisor or admin                     | Supervisor and admin PINs need 8 or more digits. An older 6-digit PIN is refused on phones (its hash is not sent) and must be replaced at the next dashboard login.                            | Log in once to the VM dashboard with the old PIN; it asks for a new 8+ digit PIN. Phones pick it up on their next sync (about 10 s). A forgotten PIN has no reset in v1: an admin can add the person again under a new name.                              |
| "Setup code is invalid" on a phone                                     | Older than 10 minutes, already used, or (for a hub code) the hub has not pulled it yet.                                                                                                       | Make a new code; wait 30 s after making hub batch codes; check the hub's `last_cloud_sync_at`.                                                                                                                                                            |
| `502 Bad Gateway` on `tickets.example.org`                             | NPM cannot reach the app.                                                                                                                                                                     | `docker compose --env-file .env -f docker/compose.vm.yml ps` and `curl http://127.0.0.1:3001/api/health` on the VM; NPM must run with `--network host` (step 2.1).                                                                                        |
