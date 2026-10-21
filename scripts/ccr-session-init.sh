#!/usr/bin/env bash
# Prepare a sandbox session: deps, MariaDB (if installed), .env from .env.demo with generated
# secrets, the dev database and user, migrations and a signing key. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install

if command -v mariadbd >/dev/null 2>&1 && ! pgrep -x mariadbd >/dev/null 2>&1; then
  mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld 2>/dev/null || true
  [ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=mysql >/dev/null 2>&1 || true
  (mariadbd --user=mysql >/tmp/mariadbd.log 2>&1 &)
  for _ in $(seq 1 30); do mariadb -uroot -e 'select 1' >/dev/null 2>&1 && break || sleep 1; done
fi

# A new .env gets generated secrets. An existing one is never edited.
if [ ! -f .env ]; then
  cp .env.demo .env
  fill() { sed -i "s|^$1=.*|$1=$2|" .env; }
  fill SESSION_SECRET "$(openssl rand -hex 32)"
  fill EVENT_KEY_MASTER "$(openssl rand -hex 32)"
  fill SIGNING_KEY_PASSPHRASE "$(openssl rand -hex 16)"
fi

set -a; . ./.env; set +a
DB_NAME="${DB_NAME:-events_qr}" DB_USER="${DB_USER:-events_qr}" DB_PASSWORD="${DB_PASSWORD:-change-me}"

# Dev database and user. The user may also create `<DB_NAME>_test*` databases for the test suite.
if command -v mariadb >/dev/null 2>&1 && mariadb -uroot -e 'select 1' >/dev/null 2>&1; then
  mariadb -uroot <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASSWORD}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1', '${DB_USER}'@'localhost';
GRANT ALL ON \`${DB_NAME}\_test%\`.* TO '${DB_USER}'@'127.0.0.1', '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
  bun scripts/migrate.ts
fi

if [ -n "${SIGNING_KEY_PATH:-}" ] && [ -n "${SIGNING_KEY_PASSPHRASE:-}" ]; then
  mkdir -p "$(dirname "${SIGNING_KEY_PATH}")"
  [ -f "${SIGNING_KEY_PATH}" ] || bun scripts/gen-signing-key.ts
else
  echo "note: .env has no SIGNING_KEY_PATH / SIGNING_KEY_PASSPHRASE (see .env.demo); skipped the signing key." >&2
fi
