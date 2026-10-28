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
set "VM=docker compose -p events-qr-dev --env-file .env -f docker/compose.vm.yml -f docker/compose.local.yml"

if not exist ".secrets" mkdir ".secrets"
if exist ".secrets\signing-key.json" (
  echo Signing key already exists: kept.
) else (
  echo.
  echo -- Creating the signing key ^(first run builds the image: several minutes^) --
  %VM% run --rm tools bun scripts/gen-signing-key.ts || goto :fail
)

echo.
echo -- Building and starting MariaDB, migrations and the app --
%VM% up -d --build app || goto :fail
call :wait_health "http://127.0.0.1:!APP_PORT!/api/health" || goto :fail

echo.
choice /c YN /m "Create an admin account now"
if not errorlevel 2 (
  call :ask ADMIN_NAME "Admin name" "Admin"
  echo The script asks for a PIN: admins need 8 or more digits.
  %VM% run --rm tools bun scripts/create-admin.ts --name "!ADMIN_NAME!" || goto :fail
)

echo.
echo Done. Open http://localhost:!APP_PORT!
echo After a code change, rebuild and restart with:
echo   %VM% up -d --build app
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
call :readenv HUB_URL ""
set "VM=docker compose --env-file .env -f docker/compose.vm.yml"

if not exist ".secrets" mkdir ".secrets"
if exist ".secrets\signing-key.json" (
  echo Signing key already exists: kept.
) else (
  echo.
  echo -- Creating the signing key ^(first run builds the image: several minutes^) --
  %VM% run --rm tools bun scripts/gen-signing-key.ts || goto :fail
  echo Back up .secrets\signing-key.json too ^(with its passphrase, kept separately^).
)

echo.
echo -- Starting MariaDB, migrations and the app --
%VM% up -d --build app || goto :fail
call :wait_health "http://127.0.0.1:!APP_PORT!/api/health" || goto :fail

echo.
choice /c YN /m "Create an admin account now"
if not errorlevel 2 (
  call :ask_required ADMIN_NAME "Admin name"
  echo The script asks for a PIN: admins need 8 or more digits.
  %VM% run --rm tools bun scripts/create-admin.ts --name "!ADMIN_NAME!" || goto :fail
)

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
  > .env.hub (
    echo # Written by setup.bat ^(hub, dev^) on %DATE% %TIME%. Runs in Docker project events-qr-hub-dev.
    echo # No secrets: the hub keeps them in its Docker volume.
    echo HUB_BIND=127.0.0.1
    echo HUB_PORT=!HUB_PORT!
  )
  echo Wrote .env.hub
)
call :readenv HUB_PORT 3100
set "HUB=docker compose -p events-qr-hub-dev --env-file .env.hub -f docker/compose.hub.yml"

echo.
echo -- Building and starting the hub ^(first run: several minutes^) --
%HUB% up -d --build || goto :fail
call :wait_health "http://127.0.0.1:!HUB_PORT!/api/health" || goto :fail

echo.
echo A dev web app on this PC is reached from inside the hub container as
echo http://host.docker.internal:3000 ^(not localhost^).
call :enroll_hub "%HUB% run --rm tools bun" "http://host.docker.internal:3000" || goto :fail

echo.
echo Done. Open http://localhost:!HUB_PORT!
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
set "HUB=docker compose --env-file .env -f docker/compose.hub.yml"

echo.
echo Make sure this machine's clock is right: phones correct their clocks against the hub.
echo.
echo -- Building and starting the hub ^(first run: several minutes^) --
%HUB% up -d --build || goto :fail
call :wait_health "http://127.0.0.1:!HUB_PORT!/api/health" || goto :fail

call :enroll_hub "%HUB% run --rm tools bun" || goto :fail

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
for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
copy /y "%ENVFILE%" "%ENVFILE%.bak-%STAMP%" >nul || exit /b 1
echo Saved the old file as %ENVFILE%.bak-%STAMP%
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

rem :enroll_hub "runner" ["default server URL"]  -> runs `<runner> scripts/hub-enroll.ts <URL> <code>`, retry on failure
:enroll_hub
echo.
echo -- Link the hub to an event --
echo You need a setup code from the server: as an admin or supervisor, open the event's
echo Hub setup tab ^(or POST /api/hubs/setup^). A code is valid for 10 minutes and works once.
choice /c YN /m "Link the hub now"
if errorlevel 2 (
  echo Skipped. Link it later with: %~1 scripts/hub-enroll.ts ^<server URL^> ^<setup code^>
  exit /b 0
)
if "%~2"=="" (
  call :ask_required VM_URL "Server address, e.g. https://tickets.example.org"
) else (
  call :ask VM_URL "Server address" "%~2"
)
:enroll_retry
call :ask_required SETUP_CODE "Setup code"
%~1 scripts/hub-enroll.ts "!VM_URL!" "!SETUP_CODE!" && exit /b 0
echo Linking failed. An expired or used code needs a new one; a network error means this
echo machine cannot reach !VM_URL! ^(check DNS and the clock^).
choice /c YN /m "Try again with another code"
if not errorlevel 2 goto :enroll_retry
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
