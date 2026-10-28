@echo off
rem Events_QR setup for Windows. Double-click it, or run `setup.bat` from the repository folder.
rem Asks: web app or hub, dev or prod, then only the details that setup needs.
rem Everything runs in Docker: this PC needs Docker Desktop and nothing else.
rem   Web app, dev  : compose.vm.yml + compose.local.yml, project events-qr-dev, http://localhost:3000
rem   Web app, prod : compose.vm.yml, see docs/setup-guide.md sections 1-3
rem   Hub, dev      : compose.hub.yml with .env.hub, project events-qr-hub-dev, http://localhost:3100
rem   Hub, prod     : compose.hub.yml, see docs/setup-guide.md section 4
rem Dev builds the images from this folder: after a code change, run the command it prints at the end.
rem Secrets are generated here and written only to .env (gitignored). Back .env up afterwards.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "ROOT=%CD:\=/%"

echo.
echo ============================================================
echo   Events_QR setup
echo ============================================================
echo.
if not exist "docker\compose.vm.yml" (
  echo This file must stay in the Events_QR repository folder.
  goto :fail
)

echo What are you setting up on this machine?
echo   1. Web app  ^(the server: makes tickets, admin pages, emails^)
echo   2. Hub      ^(the venue box: one-time entry with no internet^)
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 (set "TARGET=hub") else (set "TARGET=web")
echo.
echo Development or production?
echo   1. Dev   ^(this PC, for trying and changing the code^)
echo   2. Prod  ^(the real thing, runs in Docker and restarts on its own^)
choice /c 12 /n /m "Choose 1 or 2: "
if errorlevel 2 (set "ENV=prod") else (set "ENV=dev")
echo.
echo == Setting up: %TARGET% / %ENV% ==
echo.

call :need_docker || goto :fail

rem The hub's dev settings live in .env.hub, so a web app dev stack and a hub dev stack fit in one folder.
set "ENVFILE=.env"
if "%TARGET%_%ENV%"=="hub_dev" set "ENVFILE=.env.hub"
call :env_file_choice || goto :fail
goto :%TARGET%_%ENV%


rem ======================================================================
:web_dev
rem ======================================================================
if "%WRITE_ENV%"=="1" (
  echo -- Details for the dev web app --
  call :ask APP_PORT "Port for the app on this PC" "3000"
  call :ask EVENT_TIMEZONE "Event time zone (IANA name)" "Asia/Manila"
  call :randhex 24 DB_PASSWORD
  call :randhex 24 DB_ROOT_PASSWORD
  call :randhex 32 SESSION_SECRET
  call :randhex 32 EVENT_KEY_MASTER
  call :randhex 24 SIGNING_KEY_PASSPHRASE
  > .env (
    echo # Written by setup.bat ^(web app, dev^) on %DATE% %TIME%. Runs in Docker project events-qr-dev.
    echo APP_MODE=server
    echo DB_HOST=127.0.0.1
    echo DB_PORT=3306
    echo DB_NAME=events_qr
    echo DB_USER=events_qr
    echo DB_PASSWORD=!DB_PASSWORD!
    echo DB_ROOT_PASSWORD=!DB_ROOT_PASSWORD!
    echo SESSION_SECRET=!SESSION_SECRET!
    echo COOKIE_SECURE=false
    echo EVENT_KEY_MASTER=!EVENT_KEY_MASTER!
    echo SIGNING_KEY_PATH=.secrets/signing-key.json
    echo SIGNING_KEY_PASSPHRASE=!SIGNING_KEY_PASSPHRASE!
    echo EVENT_TIMEZONE=!EVENT_TIMEZONE!
    echo PUBLIC_URL=http://localhost:!APP_PORT!
    echo APP_BIND=127.0.0.1
    echo APP_PORT=!APP_PORT!
  )
  echo Wrote .env
)
call :readenv APP_PORT 3000
call :ensure_port APP_PORT events-qr-dev-app-1 || goto :fail

call :readenv CLOUDFLARE_TUNNEL_TOKEN ""
if not defined CLOUDFLARE_TUNNEL_TOKEN call :ask_tunnel || goto :fail
call :readenv PUBLIC_URL "http://localhost:!APP_PORT!"
set "VM=docker compose -p events-qr-dev --env-file .env -f docker/compose.vm.yml -f docker/compose.local.yml"
set "UP=app"
if defined CLOUDFLARE_TUNNEL_TOKEN (
  set "VM=!VM! --profile tunnel"
  set "UP=app tunnel"
)

if not exist ".secrets" mkdir ".secrets"
if exist ".secrets\signing-key.json" (
  echo Signing key already exists: kept.
) else (
  echo.
  echo -- Creating the signing key ^(first run builds the image: several minutes^) --
  %VM% run --rm --build tools bun scripts/gen-signing-key.ts || goto :fail
)

echo.
echo -- Building and starting MariaDB, migrations and the app --
%VM% up -d --build !UP! || (
  echo.
  echo If the migrate log says "Access denied for user 'events_qr'", the database was created with
  echo other passwords: copy the matching .env.bak-... back over .env ^(and its .secrets\signing-key.json.bak-...^),
  echo or wipe the dev database with
  echo   %VM% down -v
  echo and run setup.bat again.
  goto :fail
)
call :wait_health "http://127.0.0.1:!APP_PORT!/api/health" || goto :fail
if defined CLOUDFLARE_TUNNEL_TOKEN (
  echo.
  echo -- Tunnel log ^(look for "Registered tunnel connection"^) --
  timeout /t 5 /nobreak >nul
  %VM% logs --tail 5 tunnel
)

call :create_admin "%VM% run --rm --build tools bun" "Admin" || goto :fail

echo.
echo Done. Open !PUBLIC_URL!
if defined CLOUDFLARE_TUNNEL_TOKEN echo ^(Log in through that https address: with the tunnel, login cookies are https-only.^)
echo After a code change, rebuild and restart with:
echo   %VM% up -d --build !UP!
echo Stop it with:
echo   %VM% stop
echo Ticket emails need the worker and Gmail ^(docs/deploy-vm.md section 6^); dev works without them.
goto :done


rem ======================================================================
:web_prod
rem ======================================================================
if "%WRITE_ENV%"=="1" (
  echo -- Details for the production web app --
  echo The public address is what people and hubs open, e.g. https://tickets.example.org
  call :ask_required PUBLIC_URL "Public address of this server"
  call :ask HUB_URL "Venue hub address, e.g. https://hub.example.org (blank = set later)" ""
  call :ask EVENT_TIMEZONE "Event time zone (IANA name)" "Asia/Manila"
  echo Nginx Proxy Manager forwards to the app. Use 127.0.0.1 if it runs on this machine,
  echo 0.0.0.0 if it runs elsewhere.
  call :ask APP_BIND "Address the app listens on" "127.0.0.1"
  call :ask APP_PORT "Port the app listens on" "3001"
  call :randhex 24 DB_PASSWORD
  call :randhex 24 DB_ROOT_PASSWORD
  call :randhex 32 SESSION_SECRET
  call :randhex 32 EVENT_KEY_MASTER
  call :randhex 24 SIGNING_KEY_PASSPHRASE
  > .env (
    echo # Written by setup.bat ^(web app, prod^) on %DATE% %TIME%.
    echo # Holds secrets: keep a copy in a password manager. Losing EVENT_KEY_MASTER loses every ticket.
    echo APP_MODE=server
    echo DB_HOST=127.0.0.1
    echo DB_PORT=3306
    echo DB_NAME=events_qr
    echo DB_USER=events_qr
    echo DB_PASSWORD=!DB_PASSWORD!
    echo DB_ROOT_PASSWORD=!DB_ROOT_PASSWORD!
    echo SESSION_SECRET=!SESSION_SECRET!
    echo EVENT_KEY_MASTER=!EVENT_KEY_MASTER!
    echo SIGNING_KEY_PATH=.secrets/signing-key.json
    echo SIGNING_KEY_PASSPHRASE=!SIGNING_KEY_PASSPHRASE!
    echo EVENT_TIMEZONE=!EVENT_TIMEZONE!
    echo PUBLIC_URL=!PUBLIC_URL!
    if defined HUB_URL echo HUB_URL=!HUB_URL!
    echo APP_BIND=!APP_BIND!
    echo APP_PORT=!APP_PORT!
  )
  echo Wrote .env
  echo.
  echo IMPORTANT: copy .env into your password manager now. It holds EVENT_KEY_MASTER;
  echo losing it makes every issued ticket unreadable.
  pause
)
call :readenv APP_PORT 3000
call :ensure_port APP_PORT events-qr-app-1 || goto :fail
call :readenv HUB_URL ""
set "VM=docker compose --env-file .env -f docker/compose.vm.yml"

if not exist ".secrets" mkdir ".secrets"
if exist ".secrets\signing-key.json" (
  echo Signing key already exists: kept.
) else (
  echo.
  echo -- Creating the signing key ^(first run builds the image: several minutes^) --
  %VM% run --rm --build tools bun scripts/gen-signing-key.ts || goto :fail
  echo Back up .secrets\signing-key.json too ^(with its passphrase, kept separately^).
)

echo.
echo -- Starting MariaDB, migrations and the app --
%VM% up -d --build app || goto :fail
call :wait_health "http://127.0.0.1:!APP_PORT!/api/health" || goto :fail

call :create_admin "%VM% run --rm --build tools bun" "" || goto :fail

echo.
echo -- Ticket emails ^(Gmail service account, docs/setup-guide.md section 3^) --
choice /c YN /m "Set up Gmail sending now"
if errorlevel 2 goto :web_prod_end
call :ask_required GMAIL_SENDER "Sender address, e.g. tickets@example.org"
:ask_sa
call :ask_required SA_PATH "Full path to the service-account JSON key file"
set "SA_PATH=!SA_PATH:"=!"
if not exist "!SA_PATH!" (
  echo File not found: !SA_PATH!
  goto :ask_sa
)
copy /y "!SA_PATH!" ".secrets\gmail-sa.json" >nul || goto :fail
findstr /b /c:"GMAIL_SENDER=" .env >nul || (echo GMAIL_SENDER=!GMAIL_SENDER!>> .env)
%VM% up -d worker || goto :fail
echo Worker started. Check it with: %VM% logs worker

:web_prod_end
echo.
echo Done. The app answers on http://127.0.0.1:!APP_PORT!.
echo Still to do by hand ^(docs/setup-guide.md^):
echo   - section 1.8  nightly database backup, and back up .env and .secrets\signing-key.json
echo   - section 2    Nginx Proxy Manager, certificate, Cloudflare record, router ports 80/443
if "!HUB_URL!"=="" echo   - section 4.2  set HUB_URL in .env once the hub has a name, then: %VM% up -d app
goto :done


rem ======================================================================
:hub_dev
rem ======================================================================
if "%WRITE_ENV%"=="1" (
  echo -- Details for the dev hub --
  echo 3100 leaves 3000 free for a dev web app on this same PC.
  call :ask HUB_PORT "Port for the hub on this PC" "3100"
  set "DEV_APP_PORT=3000"
  if exist .env for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env") do if /i "%%a"=="APP_PORT" set "DEV_APP_PORT=%%b"
  echo A dev web app on this PC is reached from inside the hub container as host.docker.internal ^(not localhost^).
  call :ask HUB_SERVER_URL "Server address" "http://host.docker.internal:!DEV_APP_PORT!"
  > .env.hub (
    echo # Written by setup.bat ^(hub, dev^) on %DATE% %TIME%. Runs in Docker project events-qr-hub-dev.
    echo # No secrets: the hub keeps them in its Docker volume.
    echo HUB_BIND=127.0.0.1
    echo HUB_PORT=!HUB_PORT!
    echo HUB_SERVER_URL=!HUB_SERVER_URL!
  )
  echo Wrote .env.hub
)
call :readenv HUB_PORT 3100
call :ensure_server_url "http://host.docker.internal:3000"
call :ensure_port HUB_PORT events-qr-hub-dev-app-1 || goto :fail
set "HUB=docker compose -p events-qr-hub-dev --env-file .env.hub -f docker/compose.hub.yml"

echo.
echo -- Building and starting the hub ^(first run: several minutes^) --
%HUB% up -d --build || goto :fail
call :wait_health "http://127.0.0.1:!HUB_PORT!/api/health" || goto :fail

echo.
echo Done. Open http://localhost:!HUB_PORT!/setup
echo and enter a setup code from the event's Hub setup tab ^(valid 10 minutes, works once^).
echo After a code change, rebuild and restart with:
echo   %HUB% up -d --build
echo Stop it with:
echo   %HUB% stop
goto :done


rem ======================================================================
:hub_prod
rem ======================================================================
if "%WRITE_ENV%"=="1" (
  echo -- Details for the production hub --
  call :ask HUB_PORT "Port the hub listens on" "3000"
  call :ask_required HUB_SERVER_URL "Server address, e.g. https://tickets.example.org"
  echo.
  echo The hub can answer its own name on the venue Wi-Fi ^(docs/setup-guide.md 4.6^), needed
  echo when the router cannot hold a name override.
  choice /c YN /m "Run the hub's DNS service"
  if not errorlevel 2 (
    set "WANT_DNS=1"
    call :ask_required HUB_DOMAIN "Hub name, e.g. hub.example.org"
    call :ask_required HUB_LAN_IP "This machine's fixed LAN address, e.g. 192.168.50.10"
  )
  > .env (
    echo # Written by setup.bat ^(hub, prod^) on %DATE% %TIME%. No secrets: the hub keeps them in its Docker volume.
    echo HUB_PORT=!HUB_PORT!
    echo HUB_SERVER_URL=!HUB_SERVER_URL!
    if defined WANT_DNS (
      echo HUB_DOMAIN=!HUB_DOMAIN!
      echo HUB_LAN_IP=!HUB_LAN_IP!
      echo HUB_DNS_BIND=!HUB_LAN_IP!
    )
  )
  echo Wrote .env
) else (
  findstr /b /c:"HUB_DOMAIN=" .env >nul && set "WANT_DNS=1"
)
call :readenv HUB_PORT 3000
call :ensure_server_url ""
call :ensure_port HUB_PORT events-qr-hub-app-1 || goto :fail
set "HUB=docker compose --env-file .env -f docker/compose.hub.yml"

echo.
echo Make sure this machine's clock is right: phones correct their clocks against the hub.
echo.
echo -- Building and starting the hub ^(first run: several minutes^) --
%HUB% up -d --build || goto :fail
call :wait_health "http://127.0.0.1:!HUB_PORT!/api/health" || goto :fail

echo.
echo Open http://localhost:!HUB_PORT!/setup and enter a setup code from the event's Hub setup tab.

if defined WANT_DNS (
  echo.
  echo -- Starting the hub DNS service --
  %HUB% --profile dns up -d dns || goto :fail
  echo Set the venue router's DHCP primary DNS to !HUB_LAN_IP! and leave secondary DNS empty.
)

echo.
echo HTTPS for phones: Nginx Proxy Manager with a Let's Encrypt certificate by Cloudflare DNS
echo ^(docs/setup-guide.md 4.5^). Its admin page is on port 81 of this machine.
choice /c YN /m "Start Nginx Proxy Manager now"
if not errorlevel 2 (
  %HUB% --profile proxy up -d proxy || goto :fail
  echo Open http://localhost:81 ^(first login admin@example.com / changeme, change it at once^).
  echo Add the certificate and a proxy host to app:3000, then set HUB_BIND=127.0.0.1 in .env
  echo and run: %HUB% up -d app
)

echo.
echo Done. Check it on the event's Hub setup tab ^(admin^), at the office and at the venue.
echo Also: a Cloudflare A record for the hub name to its LAN address, grey cloud ^(setup guide 4.4^),
echo and HUB_URL in the server's .env.
goto :done


rem ======================================================================
rem Helpers
rem ======================================================================

:need_docker
where docker >nul 2>&1 || (
  echo Docker is not installed. Install Docker Desktop ^(WSL 2 engine^) from docker.com, then run this again.
  exit /b 1
)
docker info >nul 2>&1 || (
  echo Docker is installed but not running. Start Docker Desktop, wait for "Engine running", then run this again.
  exit /b 1
)
exit /b 0

rem Sets WRITE_ENV=1 when %ENVFILE% should be (re)written. An existing one is backed up, never lost.
:env_file_choice
set "WRITE_ENV=1"
if not exist "%ENVFILE%" exit /b 0
echo A %ENVFILE% file already exists here.
if "%ENV%"=="prod" if "%TARGET%"=="web" (
  echo WARNING: on a server that already ran, new database passwords and a new EVENT_KEY_MASTER
  echo would lock you out of the existing database and tickets. Keep it unless this is a fresh install.
)
choice /c KR /m "[K]eep it and continue, or [R]eplace it (the old one is saved as %ENVFILE%.bak-...)"
if not errorlevel 2 (
  set "WRITE_ENV=0"
  exit /b 0
)
rem MariaDB takes its passwords from the env file only when it first creates its volume: new
rem passwords against an existing dev database end in "Access denied for user 'events_qr'".
if not "%TARGET%_%ENV%"=="web_dev" goto :env_backup
docker volume inspect events-qr-dev_mariadb-data >nul 2>&1 || goto :env_backup
echo.
echo The dev database already exists and was created with the passwords in the current .env.
echo New passwords would lock the app out of it ^(Access denied for user 'events_qr'^).
echo   [W] Wipe the dev database and its data, then start fresh
echo   [K] Keep the current .env instead
choice /c WK /n /m "Choose W or K: "
if errorlevel 2 (
  set "WRITE_ENV=0"
  exit /b 0
)
docker compose -p events-qr-dev --env-file .env -f docker/compose.vm.yml -f docker/compose.local.yml --profile tunnel down -v || exit /b 1
:env_backup
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
copy /y "%ENVFILE%" "%ENVFILE%.bak-%STAMP%" >nul || exit /b 1
echo Saved the old file as %ENVFILE%.bak-%STAMP%
rem The signing key file is encrypted with the old SIGNING_KEY_PASSPHRASE; with a new one the app fails
rem with "Unsupported state or unable to authenticate data". Keep it beside the old .env and make a new one.
if "%TARGET%"=="web" if exist ".secrets\signing-key.json" (
  move /y ".secrets\signing-key.json" ".secrets\signing-key.json.bak-%STAMP%" >nul || exit /b 1
  echo The signing key belongs to the old passphrase: saved it as .secrets\signing-key.json.bak-%STAMP%.
  echo A new key is made below. To go back, restore both .bak-%STAMP% files.
)
exit /b 0

rem :ask VAR "Prompt" "default"
:ask
set "%~1="
if "%~3"=="" (set /p "%~1=%~2: ") else (set /p "%~1=%~2 [%~3]: ")
if not defined %~1 set "%~1=%~3"
exit /b 0

rem :ask_required VAR "Prompt"
:ask_required
set "%~1="
set /p "%~1=%~2: "
if not defined %~1 (
  echo   This one is required.
  goto :ask_required
)
exit /b 0

rem :randhex BYTES VAR  -> VAR = 2*BYTES random hex characters (cryptographic RNG)
:randhex
set "%~2="
for /f %%h in ('powershell -NoProfile -Command "$b = New-Object byte[] %~1; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [BitConverter]::ToString($b).Replace('-','').ToLower()"') do set "%~2=%%h"
if not defined %~2 (
  echo Could not generate a random secret with PowerShell.
  exit /b 1
)
exit /b 0

rem :readenv VAR default  -> VAR from %ENVFILE%, else default
:readenv
set "%~1=%~2"
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ENVFILE%") do if /i "%%a"=="%~1" set "%~1=%%b"
exit /b 0

rem :ask_tunnel  -> optionally puts the dev app behind a Cloudflare Tunnel; writes the settings into .env.
:ask_tunnel
echo.
echo -- Cloudflare Tunnel ^(optional^) --
echo Gives the dev app a real https address, e.g. https://dev.example.org, so phones can scan with it.
echo No port forwarding or certificate needed; this PC must stay on and awake while people use it.
choice /c YN /m "Put the dev app behind a Cloudflare Tunnel"
if errorlevel 2 exit /b 0
echo.
echo In the Cloudflare dashboard: Zero Trust - Networks - Tunnels - Create a tunnel:
echo   1. Connector type Cloudflared, any name, Save tunnel.
echo   2. Choose Docker and copy only the long token after "--token " ^(do not run the command^).
echo   3. Public hostname: your subdomain and domain, Service type HTTP, URL app:3000. Save.
echo The URL is app:3000, not localhost: cloudflared runs as a container next to the app.
echo.
call :ask_required TUNNEL_URL "Public address you chose, e.g. https://dev.example.org"
call :ask_required TUNNEL_TOKEN "Tunnel token (a secret: saved only in .env)"
call :setenv PUBLIC_URL "!TUNNEL_URL!" || exit /b 1
call :setenv DEV_COOKIE_SECURE "true" || exit /b 1
call :setenv CLOUDFLARE_TUNNEL_TOKEN "!TUNNEL_TOKEN!" || exit /b 1
set "TUNNEL_TOKEN="
cls
echo Saved the tunnel settings in .env ^(screen cleared so the token is not left on it^).
exit /b 0

rem :setenv VAR "value"  -> sets VAR=value in %ENVFILE%, replacing its line or adding one.
:setenv
powershell -NoProfile -Command "$f='%ENVFILE%'; $k='%~1'; $v='%~2'; $l=@(Get-Content $f); if ($l | Where-Object { $_.StartsWith($k + '=') }) { $l = $l | ForEach-Object { if ($_.StartsWith($k + '=')) { $k + '=' + $v } else { $_ } } } else { $l += ($k + '=' + $v) }; Set-Content $f $l" || exit /b 1
set "%~1=%~2"
exit /b 0

rem :ensure_port VAR container  -> if port !VAR! is taken by anything but our own container, say what
rem holds it, ask for another port and write it into %ENVFILE% (VAR=, and localhost:<port> in addresses).
:ensure_port
set "PORT_NOW=!%~1!"
docker ps --filter "name=%~2" --format "{{.Ports}}" 2>nul | findstr /c:":!PORT_NOW!->" >nul && exit /b 0
netstat -ano | findstr /r /c:"TCP.*:!PORT_NOW! .*LISTENING" >nul || exit /b 0
echo.
echo Port !PORT_NOW! on this PC is already in use by:
set "HOLDER="
for /f "delims=" %%n in ('docker ps --filter "publish=!PORT_NOW!" --format "{{.Names}}" 2^>nul') do (
  echo   Docker container %%n
  set "HOLDER=1"
)
if not defined HOLDER (
  for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:!PORT_NOW! .*LISTENING"') do (
    for /f "tokens=1 delims=," %%t in ('tasklist /fi "PID eq %%p" /fo csv /nh') do echo   program %%~t ^(PID %%p^)
  )
)
echo Stop that program or container, or use another port for this setup.
call :ask_required NEW_PORT "Port to use instead, e.g. 3005"
powershell -NoProfile -Command "$f='%ENVFILE%'; (Get-Content $f) | ForEach-Object { if ($_.StartsWith('%~1=')) { '%~1=!NEW_PORT!' } else { $_.Replace('localhost:!PORT_NOW!','localhost:!NEW_PORT!') } } | Set-Content $f" || exit /b 1
findstr /b /c:"%~1=" "%ENVFILE%" >nul || (echo %~1=!NEW_PORT!>> "%ENVFILE%")
set "%~1=!NEW_PORT!"
echo Saved %~1=!NEW_PORT! in %ENVFILE%.
goto :ensure_port

rem :wait_health url
:wait_health
echo Waiting for %~1 ...
for /l %%i in (1,1,60) do (
  curl.exe -fsS "%~1" >nul 2>&1 && (
    curl.exe -s "%~1"
    echo.
    exit /b 0
  )
  timeout /t 5 /nobreak >nul
)
echo No answer after 5 minutes. Look at the logs: the same docker compose command with `logs` at the end.
exit /b 1

rem :create_admin "runner" "default name"  -> asks for the first admin and runs scripts/create-admin.ts.
rem A taken name (exit code 3) offers: reset that account's PIN, another name, or skip. Other errors
rem (a PIN too short, the database not ready) offer: try again, skip, or stop the setup.
:create_admin
echo.
choice /c YN /m "Create an admin account now"
if errorlevel 2 exit /b 0
:create_admin_name
if "%~2"=="" (call :ask_required ADMIN_NAME "Admin name") else (call :ask ADMIN_NAME "Admin name" "%~2")
set "ADMIN_MODE=fail"
:create_admin_run
%~1 scripts/create-admin.ts --name "!ADMIN_NAME!" --if-exists !ADMIN_MODE!
set "RC=!ERRORLEVEL!"
if "!RC!"=="0" exit /b 0
echo.
if "!RC!"=="3" (
  echo An account named "!ADMIN_NAME!" already exists ^(from an earlier run^).
  echo   [R] Reset it: give it a new PIN and make it an admin ^(its history stays^)
  echo   [N] Use a different name
  echo   [S] Skip: keep it as it is
  choice /c RNS /n /m "Choose R, N or S: "
  if errorlevel 3 exit /b 0
  if errorlevel 2 goto :create_admin_name
  set "ADMIN_MODE=reset"
  goto :create_admin_run
)
echo Creating the admin failed ^(see above: a PIN shorter than 8 digits is refused for an admin^).
echo   [T] Try again   [S] Skip this step   [Q] Stop the setup
choice /c TSQ /n /m "Choose T, S or Q: "
if errorlevel 3 exit /b 1
if errorlevel 2 exit /b 0
goto :create_admin_run

rem :ensure_server_url "default"  -> HUB_SERVER_URL from %ENVFILE%; an older env file without it gets it asked and added.
:ensure_server_url
call :readenv HUB_SERVER_URL ""
if defined HUB_SERVER_URL exit /b 0
if "%~1"=="" (
  call :ask_required HUB_SERVER_URL "Server address, e.g. https://tickets.example.org"
) else (
  call :ask HUB_SERVER_URL "Server address" "%~1"
)
call :setenv HUB_SERVER_URL "!HUB_SERVER_URL!" || exit /b 1
exit /b 0

:fail
echo.
echo Setup stopped. Fix the message above and run setup.bat again: finished steps are skipped or harmless to repeat.
pause
exit /b 1

:done
echo.
pause
exit /b 0
