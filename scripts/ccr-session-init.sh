#!/usr/bin/env bash
# Prepare a sandbox session: deps, MariaDB (if installed), .env from .env.demo. Idempotent.
set -euo pipefail
cd "$(dirname "$0")/.."

bun install

if command -v mariadbd >/dev/null 2>&1 && ! pgrep -x mariadbd >/dev/null 2>&1; then
  mkdir -p /run/mysqld && chown mysql:mysql /run/mysqld 2>/dev/null || true
  [ -d /var/lib/mysql/mysql ] || mariadb-install-db --user=mysql >/dev/null 2>&1 || true
  (mariadbd --user=mysql >/tmp/mariadbd.log 2>&1 &)
fi

[ -f .env ] || cp .env.demo .env
