#!/usr/bin/env bash
# Restore a backup made by backup.sh. Needs the PRIVATE age key file (kept off the server).
#   sudo bash infra/deploy/restore.sh <backup.tar.age> <private-key-file>
# Opens the backup into a folder and, only if you type YES, replaces the live database with it.
# The api, worker and web stop during the restore and start again afterwards.
set -euo pipefail
cd "$(dirname "$0")/../.."
[ $# -eq 2 ] || { echo "Usage: sudo bash infra/deploy/restore.sh <backup.tar.age> <private-key-file>" >&2; exit 1; }
backup=$1
key=$2
COMPOSE=(docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml)

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
age -d -i "$key" "$backup" | tar -C "$out" -xf -
ls -l "$out"

printf 'Replace the LIVE database with this backup? Type YES: '
read -r answer
[ "$answer" = "YES" ] || { echo "Cancelled. Nothing changed."; exit 0; }

"${COMPOSE[@]}" stop api worker web
"${COMPOSE[@]}" exec -T postgres psql -U timekeeper -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS timekeeper WITH (FORCE)" -c "CREATE DATABASE timekeeper OWNER timekeeper"
"${COMPOSE[@]}" exec -T postgres pg_restore -U timekeeper -d timekeeper --no-owner <"$out/db.dump"
if [ -s "$out/storage.tar" ]; then
  "${COMPOSE[@]}" run --rm -T --no-deps api sh -c 'tar -C /data/storage -xf -' <"$out/storage.tar" || true
fi
"${COMPOSE[@]}" up -d
echo "Restored. (If you also lost the server: the old .env is inside the backup: age -d -i KEY BACKUP | tar -xf - ./env)"
