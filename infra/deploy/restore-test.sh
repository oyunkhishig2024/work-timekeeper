#!/usr/bin/env bash
# Proves a backup can be opened, WITHOUT touching the live data: decrypts it, restores it into a scratch database,
# prints how many rows the main tables have, and deletes the scratch database and the decrypted files.
#   bash infra/deploy/restore-test.sh <backup.tar.age> <private-key-file>
set -euo pipefail
cd "$(dirname "$0")/../.."
[ $# -eq 2 ] || { echo "Usage: bash infra/deploy/restore-test.sh <backup.tar.age> <private-key-file>" >&2; exit 1; }
backup=$1
key=$2
COMPOSE=(docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml)
scratch=restore_test_$$

out=$(mktemp -d)
cleanup() {
  "${COMPOSE[@]}" exec -T postgres dropdb -U timekeeper --if-exists "$scratch" >/dev/null 2>&1 || true
  rm -rf "$out"
}
trap cleanup EXIT

if ! age -d -i "$key" "$backup" | tar -C "$out" -xf - 2>/dev/null; then
  echo "RESTORE TEST FAILED: the backup could not be opened (wrong key file or damaged backup)" >&2
  exit 1
fi
[ -s "$out/db.dump" ] || { echo "RESTORE TEST FAILED: the backup has no database dump" >&2; exit 1; }
echo "Backup opened. Files: $(find "$out" -maxdepth 1 -type f -printf '%f ')"

"${COMPOSE[@]}" exec -T postgres createdb -U timekeeper "$scratch"
"${COMPOSE[@]}" exec -T postgres pg_restore -U timekeeper -d "$scratch" --no-owner <"$out/db.dump"

"${COMPOSE[@]}" exec -T postgres psql -U timekeeper -d "$scratch" -At -c "
  SELECT 'tenants: ' || count(*) FROM tenant
  UNION ALL SELECT 'employees: ' || count(*) FROM employee
  UNION ALL SELECT 'events: ' || count(*) FROM device_event
  UNION ALL SELECT 'daily results: ' || count(*) FROM attendance_result"
echo "RESTORE TEST OK: the backup can be restored. The scratch database is removed."
