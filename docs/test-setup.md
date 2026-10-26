# Test copy: a safe place to try things

A second, separate copy of the system on the same VM as production, at `test.<domain>`. Use it to try a new version before production gets it, to train staff, to rehearse with the 50 test tickets, or just to click around. Nothing in it can reach production data or email a real person.

It can run in two places:

- **On the production VM**, beside production (sections 1–4). This assumes production is already installed with [`docs/setup-guide.md`](setup-guide.md).
- **On your own Windows PC**, reached through a Cloudflare Tunnel, with nothing on the VM at all (section 5).

Either way it is the same stack (`docker/compose.test.yml`). The commands below use `test.example.org`, `hub-test.example.org` and `tickets.example.org` (production): replace them with your own.

## How it differs from production

| | Production | Test copy |
|---|---|---|
| Folder on the VM | `~/events-qr` | `~/events-qr-test` (its own clone, so it can run a newer version) |
| Docker project | `events-qr` (`docker/compose.vm.yml`) | `events-qr-test` (`docker/compose.test.yml`) |
| Settings | `.env` | `.env.test` (from `.env.test.example`), all secrets new |
| Database | own MariaDB volume | own MariaDB volume, database `events_qr_test` |
| Signing key | `.secrets/` | `.secrets-test/`, a different key |
| App port (loopback) | 3001 | 3002 |
| Address | `tickets.<domain>` | `test.<domain>` |
| Email | Gmail API, real recipients | Mailpit: every email lands in a web inbox, nothing leaves the VM |
| Looks | normal | red **TEST COPY** bar on every dashboard page and on the phone scanner; email subjects start with `[TEST]` |
| Hub | `hub.<domain>` | `hub-test.<domain>`: the spare hub or a laptop (optional) |

Tickets from one copy do not work on the other: each has its own signing key and event keys, so a test ticket shows **Not an event ticket** at a real gate, and the other way round. That only holds if `.env.test` and `.secrets-test` really are new: never copy production's into the test copy.

The two copies share the VM's CPU and memory. That is fine for testing, but stop the test copy (section 4) during a live event.

---

## 1. Set it up once

### 1.1 Clone a second copy

On the VM, next to production:

```bash
cd ~
git clone https://github.com/sealis04/events_qr.git events-qr-test
cd events-qr-test
```

**Check:** `ls docker/compose.test.yml .env.test.example` lists both files.
**If it fails:** an old clone without these files: `git pull` in `~/events-qr-test`.

### 1.2 Fill in `.env.test`

```bash
cp .env.test.example .env.test
chmod 600 .env.test
for v in DB_PASSWORD DB_ROOT_PASSWORD SESSION_SECRET EVENT_KEY_MASTER SIGNING_KEY_PASSPHRASE; do
  sed -i "s|^$v=$|$v=$(openssl rand -hex 32)|" .env.test
done
nano .env.test
```

The loop fills every secret with a new random value. In the editor, set `PUBLIC_URL` to `https://test.<domain>` and `PRODUCTION_URL` to your production address. They must differ, or the reset script refuses to run. Leave `INSTANCE_LABEL=TEST` and the database name (it must contain `test`).

**Check:** `grep -cE '^(DB_PASSWORD|DB_ROOT_PASSWORD|SESSION_SECRET|EVENT_KEY_MASTER|SIGNING_KEY_PASSPHRASE)=.{64}$' .env.test` prints `5`, and `grep -E '^(PUBLIC_URL|PRODUCTION_URL|INSTANCE_LABEL)=' .env.test` shows your two addresses and `TEST`.
**If it fails:** fewer than 5 means a line was not empty before the loop: put a fresh `openssl rand -hex 32` value there by hand. Never paste production's values.

### 1.3 Make the test copy's own signing key

```bash
mkdir -p .secrets-test test-output && sudo chown 1000:1000 .secrets-test test-output && chmod 700 .secrets-test
docker compose --env-file .env.test -f docker/compose.test.yml run --rm tools bun scripts/gen-signing-key.ts
```

The first run builds the image (a few minutes). `test-output` is where the reset script writes the printable ticket sheet.

**Check:** the script prints `wrote /secrets/signing-key.json with key 1 (public ...)`, and `sudo ls -ln .secrets-test/` shows `signing-key.json` owned by `1000 1000`.
**If it fails:** `EACCES` means the folder is not owned by 1000 (run the `chown` again). `refuses to overwrite` means the key already exists (keep it).

### 1.4 Start it

```bash
docker compose --env-file .env.test -f docker/compose.test.yml up -d --build
docker compose --env-file .env.test -f docker/compose.test.yml ps
curl -s http://127.0.0.1:3002/api/health
```

This starts the test database, its migrations, the app on port 3002, the email worker and Mailpit.

**Check:** `mariadb`, `mailpit`, `app` and `worker` are `running` (`app` becomes `healthy`, `migrate` shows `exited (0)`), and the health call prints `{"ok":true,"mode":"server","last_cloud_sync_at":null,"instance_label":"TEST"}`.
**If it fails:** `docker compose --env-file .env.test -f docker/compose.test.yml logs migrate app worker`. `port is already allocated` on 3002 or 8025: set `APP_PORT` or `MAILPIT_PORT` in `.env.test` to a free port and run the `up` again. If `instance_label` is missing, `INSTANCE_LABEL` is empty in `.env.test`.

### 1.5 Reset it to the demo state

```bash
docker compose --env-file .env.test -f docker/compose.test.yml run --rm tools \
  bun scripts/test-reset.ts --yes --out /out/test-sheet.html
```

This empties the test database, re-applies the migrations, creates three accounts and seeds the "Dress rehearsal" event with its 50 tickets (the same mix as [`docs/field-test.md`](field-test.md)). It prints the accounts:

| Account | Role | PIN (default) |
|---|---|---|
| Test Admin | admin | `20262026` |
| Test Supervisor | supervisor | `30303030` |
| Test Staff | staff | `404040` |

To use other PINs, set `TEST_ADMIN_PIN`, `TEST_SUPERVISOR_PIN` and `TEST_STAFF_PIN` in `.env.test` (admin and supervisor need 8+ digits). The printable sheet, with one QR per ticket, is `test-output/test-sheet.html`: copy it to your computer (`scp vm:~/events-qr-test/test-output/test-sheet.html .`) and print it, or open it on a laptop screen.

**Check:** the script ends with `"Dress rehearsal" is event 1: 50 tickets, sheet at /out/test-sheet.html`, and `ls -l test-output/test-sheet.html` shows the file.
**If it fails:** `refusing to run: ...` names the safety check that failed: `INSTANCE_LABEL` empty, `DB_NAME` without "test", or `PUBLIC_URL` equal to `PRODUCTION_URL` (fix `.env.test`). `EACCES` on `/out` means `test-output` is not owned by 1000 (step 1.3).

The script **refuses to run against production**: production has no `INSTANCE_LABEL` and its database name has no "test" in it.

### 1.6 Give it an address: Cloudflare and Nginx Proxy Manager

Like production (setup guide steps 2.2 and 2.4), with the test names:

1. **Cloudflare:** add an `A` record `test` pointing to your public IP. It can be proxied (orange cloud), as production's is.
2. **Nginx Proxy Manager:** **Hosts → Proxy Hosts → Add Proxy Host**: domain `test.example.org`, scheme `http`, forward host `127.0.0.1`, port `3002`, tick **Websockets Support** and **Block Common Exploits**. On the **SSL** tab request a new Let's Encrypt certificate and tick **Force SSL**.

**Check:** `https://test.example.org` opens the login page with the red **TEST COPY** bar at the top. Log in as **Test Admin**: the event list shows "Dress rehearsal".
**If it fails:** a 502 from NPM means the app is not on 3002 (step 1.4). No red bar means `INSTANCE_LABEL` is empty: set it and run `docker compose --env-file .env.test -f docker/compose.test.yml up -d app`. Certificate errors: see the setup guide's troubleshooting table.

### 1.7 Open the test inbox (Mailpit)

Every email the test copy sends lands here. It listens on the VM's loopback only (port 8025), so nobody on the internet can read it. From your own computer:

```bash
ssh -L 8025:127.0.0.1:8025 you@<VM address>
```

then open `http://localhost:8025` while the SSH session is open.

(If you would rather have it at an address, add an NPM proxy host `mail-test.example.org` → `127.0.0.1:8025` **with an Access List** (Access Lists → Add, with a username and password) and a Cloudflare record. Never publish it without the access list: the inbox shows every test ticket.)

**Check:** generate a ticket for any email address in the test dashboard (event → **Issue tickets**, fill an email, **Generate**). Within about 10 seconds it appears in Mailpit, with the subject starting `[TEST]` and the QR in the message.
**If it fails:** nothing in Mailpit: `docker compose --env-file .env.test -f docker/compose.test.yml logs worker`. `MAIL_TRANSPORT=smtp needs SMTP_HOST and MAIL_FROM` means `MAIL_FROM` is empty in `.env.test`.

### 1.8 A test hub (optional)

Only needed to test hub and offline behaviour. Use the **spare hub** or any laptop with Docker, set up as in setup guide section 4 but with the test names:

1. **Cloudflare:** an `A` record `hub-test` → the test hub's LAN IP, **DNS only** (grey cloud). Get its certificate as in setup guide step 4.5, for `hub-test.example.org`. Add it to the router's local DNS override (step 4.6) if you test with the internet cut.
2. **VM:** set `HUB_URL=https://hub-test.example.org` in `~/events-qr-test/.env.test`, then `docker compose --env-file .env.test -f docker/compose.test.yml up -d app`.
3. **Hub setup code** from the test copy (as setup guide step 4.2, against `https://test.example.org` and as **Test Supervisor**), then on the test hub:

   ```bash
   docker compose -f docker/compose.hub.yml up -d --build
   docker compose -f docker/compose.hub.yml run --rm tools \
     bun scripts/hub-enroll.ts https://test.example.org <setup code>
   ```

**Check:** `hub-enroll` prints `hub linked to https://test.example.org for event 1: 50 tickets, ...`, and `curl -s http://127.0.0.1:3000/api/health` on the hub shows `"instance_label"` only if you also set `INSTANCE_LABEL=TEST` for the hub (optional: add it under `environment:` of `app` in your local copy of `docker/compose.hub.yml`).
**If it fails:** as setup guide step 4.3.

**Using the standby hub for tests:** before the next real event, wipe it and bind it back to production. Check that its health shows `"pending_scans":0` first:

```bash
docker compose -f docker/compose.hub.yml down -v
docker compose -f docker/compose.hub.yml up -d --build
docker compose -f docker/compose.hub.yml run --rm tools \
  bun scripts/hub-enroll.ts https://tickets.example.org <production setup code>
```

`down -v` deletes the hub's local data (the test tickets and keys), so no test data is left on it.

---

## 2. Everyday use

| To... | Run (in `~/events-qr-test`) |
|---|---|
| Start over with the 50 demo tickets | `docker compose --env-file .env.test -f docker/compose.test.yml run --rm tools bun scripts/test-reset.ts --yes --out /out/test-sheet.html` |
| See test emails | SSH tunnel, then `http://localhost:8025` (step 1.7) |
| Set up a phone | Log in as **Test Supervisor** → event → **Devices** → **Add a scanner**, then on the phone open `https://test.example.org/scan` → **Set up for event** |
| Log in on a phone | **Test Staff** / `404040` |

After a reset, set up the test phones and the test hub again (the reset deletes every device). On a phone that was set up for the test copy, tap **Set up again** first.

**Phones used for both copies:** a phone holds one setup at a time. Before using a test phone at a real event, tap **Set up again** on the test copy (it wipes the test data), then set it up from production's Devices page.

## 3. Try a new version on the test copy first

```bash
cd ~/events-qr-test
git pull
docker compose --env-file .env.test -f docker/compose.test.yml up -d --build
```

Then run through the things you care about: a reset, a ticket by email, a scan, a scan with the test hub's internet cut. Only when that works, upgrade production (setup guide section 6). To try a branch that is not merged yet, use `git checkout <branch>` instead of `git pull`.

**Check:** `curl -s http://127.0.0.1:3002/api/health` answers `ok` and the test dashboard shows the change.
**If it fails:** `docker compose --env-file .env.test -f docker/compose.test.yml logs migrate app`. A failing migration here is exactly what this step is for: do not upgrade production until it is fixed.

## 4. Stop or remove it

| To... | Run (in `~/events-qr-test`) |
|---|---|
| Stop it (e.g. during a live event) | `docker compose --env-file .env.test -f docker/compose.test.yml stop` |
| Start it again | `docker compose --env-file .env.test -f docker/compose.test.yml start` |
| Remove it completely | `docker compose --env-file .env.test -f docker/compose.test.yml down -v`, then delete `~/events-qr-test` and the NPM and Cloudflare entries |

`down -v` deletes the test database volume. Production is not touched: it is a different Docker project with its own volume.

## 5. Run it on your own Windows PC with a Cloudflare Tunnel

The same test copy, on your PC instead of the VM. A Cloudflare Tunnel gives it `https://test.<domain>`: no port forwarding, no Nginx Proxy Manager, no certificate to manage, and nothing installed on the production VM. Phones reach it over any internet connection.

```text
phone / browser ──https──▶ Cloudflare ──tunnel──▶ cloudflared (container) ──▶ app:3000 (test app)
your browser on the PC ──────────────────────────────────────────────────────▶ localhost:8025 (Mailpit)
```

What you give up: the PC must be on and awake for anyone to reach the test copy, and you cannot test a **venue hub** this way (a hub needs a local certificate and DNS name, section 1.8). Phone-only offline mode (airplane mode, scan, reconnect) works fine.

If the test copy already runs on the VM, pick one: remove it there first (section 4) and delete its `test` DNS record and NPM proxy host, or give the PC copy another name such as `test2.<domain>`.

### 5.1 Install WSL2 and Docker Desktop

1. Open **PowerShell as administrator** and run `wsl --install`. Restart when asked. After the restart an **Ubuntu** window opens: choose a user name and password.
2. Install **Docker Desktop** for Windows from docker.com. In Docker Desktop **Settings → General**, tick **Use the WSL 2 based engine** and **Start Docker Desktop when you sign in to your computer**. In **Settings → Resources → WSL integration**, switch on **Ubuntu**. Apply and restart Docker Desktop.
3. In the **Ubuntu** terminal (Start menu → Ubuntu):

   ```bash
   sudo apt update && sudo apt install -y git openssl
   ```

**Every command below runs in the Ubuntu terminal**, not in PowerShell or cmd.

**Check:** in Ubuntu, `docker version` shows both a `Client` and a `Server` section, and `docker run --rm hello-world` prints `Hello from Docker!`.
**If it fails:** `Cannot connect to the Docker daemon` means Docker Desktop is not running or WSL integration for Ubuntu is off (step 2). `wsl --install` errors about virtualization: switch on virtualization (VT-x / AMD-V, sometimes "SVM") in the PC's BIOS/UEFI settings.

### 5.2 Get the code and set it up

Clone **inside Ubuntu's own home folder**, not under `/mnt/c/...`: the Windows drive is much slower from Docker and does not keep Linux file owners, which the key folder needs.

```bash
cd ~
git clone https://github.com/sealis04/events_qr.git events-qr-test
cd events-qr-test
```

Then do **steps 1.2 to 1.5 exactly as written** (fill `.env.test`, make the signing key, start, reset), in this Ubuntu terminal. In step 1.2 set `PUBLIC_URL=https://test.example.org` (your test name) and `PRODUCTION_URL` to your production address. `sudo` asks for the Ubuntu password you chose in 5.1.

**Check:** step 1.5's check passes, and `curl -s http://127.0.0.1:3002/api/health` shows `"instance_label":"TEST"`. You can also open `http://localhost:3002` in your Windows browser: the login page with the red bar (only this PC can reach this address).
**If it fails:** as in steps 1.2–1.5. A very slow first build is normal on a laptop (5–15 minutes).

### 5.3 Create the tunnel in Cloudflare

In the Cloudflare dashboard, open **Zero Trust** (left menu), then **Networks → Tunnels → Create a tunnel**:

1. Connector type **Cloudflared**, name it `events-qr-test`, **Save tunnel**.
2. On the **Install and run a connector** page choose **Docker**. It shows a command ending in `--token eyJ...`: copy only that long token (everything after `--token `). Do **not** run the command; the test copy runs `cloudflared` itself. Click **Next**.
3. **Public hostname** (called **Published application routes** in newer dashboards; on an existing tunnel: **Configure → Public hostname → Add**): subdomain `test`, domain your domain, path empty. **Service**: type `HTTP`, URL `app:3000`. **Save tunnel**.

Cloudflare creates the `test` DNS record and its certificate by itself.

**Check:** **Networks → Tunnels** lists `events-qr-test` (status *Inactive* until the next step), and **DNS → Records** for your domain has a `CNAME` `test` pointing to `<tunnel id>.cfargotunnel.com`.
**If it fails:** "record already exists" means `test` is already used (for example by the VM copy, or an `A` record you made earlier): delete that record under **DNS → Records** and add the public hostname again.

The URL is `app:3000`, not `localhost:3002`: `cloudflared` runs as a container next to the app and reaches it by its service name.

### 5.4 Start the tunnel

Put the token in `.env.test` (it is a secret: this file only, never in git or chat):

```bash
nano .env.test   # set CLOUDFLARE_TUNNEL_TOKEN=eyJ... (remove the # in front of the line)
docker compose --env-file .env.test -f docker/compose.test.yml --profile tunnel up -d
docker compose --env-file .env.test -f docker/compose.test.yml --profile tunnel logs tunnel | tail -5
```

**Check:** the log shows `Registered tunnel connection` (usually four times); in Cloudflare the tunnel's status is **Healthy**; on a phone **using mobile data** (not your Wi-Fi), `https://test.example.org` opens the login page with the red **TEST COPY** bar, and you can log in as **Test Admin**.
**If it fails:** see the tunnel rows in the troubleshooting table below.

From now on, start and stop the PC copy with `--profile tunnel` in the command, so the tunnel comes and goes with the app:

| To... | Run (in `~/events-qr-test`, Ubuntu) |
|---|---|
| Start | `docker compose --env-file .env.test -f docker/compose.test.yml --profile tunnel up -d` |
| Stop | `docker compose --env-file .env.test -f docker/compose.test.yml --profile tunnel stop` |
| Reset to the demo state | step 1.5's command (the tunnel keeps running) |

### 5.5 Mailpit and the ticket sheet on the PC

- **Test inbox:** open `http://localhost:8025` in your Windows browser. No SSH tunnel is needed on the PC. Do not add Mailpit to the Cloudflare tunnel: anyone could read the test tickets.
- **Printable ticket sheet:** after a reset, run `explorer.exe test-output` in `~/events-qr-test` and open `test-sheet.html` from the window that appears.

**Check:** generate a ticket with an email address on `https://test.example.org`; it shows up at `http://localhost:8025` within about 10 seconds, subject starting `[TEST]`.
**If it fails:** as step 1.7.

### 5.6 Keep it reachable

- **Sleep:** Windows **Settings → System → Power** (or **Power & battery**): set "When plugged in, put my device to sleep after" to **Never** while people are testing. A sleeping PC means "This site can't be reached" / Cloudflare error 1033 on the phones.
- **After a restart:** Docker Desktop starts when you sign in (step 5.1) and brings the containers back on its own (they are `restart: unless-stopped`). You only need to sign in to Windows.
- **Updating:** section 3 works the same here (`git pull`, then the start command with `--build`).

### 5.7 Optional: only your people can open it (Cloudflare Access)

**Zero Trust → Access → Applications → Add an application → Self-hosted**: application domain `test.example.org`; add a policy **Allow** with **Emails** (your staff's addresses) or **Emails ending in** your domain. Visitors then get a one-time code by email before the test copy opens; on a phone they do this once and then use the scanner as usual.

**Check:** a private browser window on `https://test.example.org` shows Cloudflare's sign-in page first; after the code, the test copy with the red bar.
**If it fails:** if a phone's scanner suddenly says it cannot reach the server, its Access sign-in expired: open `https://test.example.org` in that phone's browser, sign in again, then go back to the scanner. Set **Session Duration** on the application to 24 hours or more to make this rare.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `test-reset` says `refusing to run` | It names the failed check. Fix `.env.test` (`INSTANCE_LABEL`, a `DB_NAME` containing "test", `PUBLIC_URL` different from `PRODUCTION_URL`). It is meant to refuse production. |
| No red TEST COPY bar | `INSTANCE_LABEL` is empty in `.env.test`; set it and run `docker compose --env-file .env.test -f docker/compose.test.yml up -d app`. A phone that cannot reach the server shows the bar from its last visit. |
| A test ticket works at a real gate | The two copies share a secret. Make new `EVENT_KEY_MASTER` and signing key for the test copy (steps 1.2, 1.3), reset, and check `.env.test` against `.env`. |
| No emails in Mailpit | `docker compose --env-file .env.test -f docker/compose.test.yml logs worker`; `MAIL_FROM` must be set. Mailpit keeps the newest 2,000 messages. |
| `port is already allocated` | Set `APP_PORT` / `MAILPIT_PORT` in `.env.test` to free ports and point the NPM proxy host at the new app port. |
| Phone set up for the test copy shows "Not an event ticket" on real tickets | Expected: it holds the test copy's keys. Tap **Set up again** and set it up from production. |
| Test hub shows test tickets after switching it back | You skipped `down -v`. Run the three commands in "Using the standby hub for tests". |
| VM slow during a live event | Stop the test copy (section 4). |
| PC copy: `"cloudflared tunnel run" requires the ID or name of the tunnel` in `logs tunnel` | `CLOUDFLARE_TUNNEL_TOKEN` is empty or still has a `#` in front in `.env.test` (step 5.4). Fix it and run the start command again. |
| PC copy: `Provided Tunnel token is not valid` | The token was copied incompletely. Copy it again from Zero Trust → Networks → Tunnels → `events-qr-test` → Configure (step 5.3). |
| PC copy: Cloudflare error 502 / "Unable to reach the origin service" | The app container is not running (`docker compose ... ps`), or the public hostname's service is not `http://app:3000` (`localhost:3002` does not work from inside the tunnel container). |
| PC copy: Cloudflare error 1033 | The tunnel is down: the PC is asleep or off, Docker Desktop is not running, or the tunnel container stopped. Wake the PC, start Docker Desktop, run the start command (step 5.4). |
| PC copy: login says "cross-origin request refused" | In the tunnel's public hostname, open **Additional application settings → HTTP Settings** and set **HTTP Host Header** to `test.example.org`. |
| PC copy: very slow, or `EACCES` on `.secrets-test` | The clone is under `/mnt/c/...`. Clone again inside Ubuntu's home folder (step 5.2). |
