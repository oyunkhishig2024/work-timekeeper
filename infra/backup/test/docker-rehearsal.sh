#!/usr/bin/env bash
# End-to-end proof of point-in-time recovery for the DOCKER setup that production uses (infra/deploy/docker-compose.yml:
# image postgres.Dockerfile, archive_command, volumes). It starts only the postgres service under its own project name
# and temp folders, then: takes a base backup, writes data, notes a time, writes "a mistake", archives the WAL,
# (1) restores a side copy to that time and checks the mistake is gone, (2) destroys the production volume and restores
# into it (the real disaster procedure) and checks the database starts with the data from before the mistake.
# Needs: docker (daemon running), age-keygen. Takes about 3-6 minutes (the image is built once).
# Usage: infra/backup/test/docker-rehearsal.sh      KEEP=1 keeps the temp folder and containers; SKIP_BUILD=1 uses a prebuilt image.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
for c in docker age-keygen; do command -v "$c" >/dev/null || { echo "missing tool: $c" >&2; exit 2; }; done
docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 2; }

W=$(mktemp -d /tmp/tk-pitr-docker.XXXXXX)
P=tkpitrtest
BIN=/opt/timekeeper/infra/backup/bin
IMAGE=timekeeper-postgres:16
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL  $1" >&2; }
eq() { if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else bad "$1: expected '$2' got '$3'"; fi; }

age-keygen -o "$W/key.txt" 2>/dev/null
chmod 644 "$W/key.txt" # throwaway test key; the container user (uid 999) must read it
PUB=$(grep -o 'age1[0-9a-z]*' "$W/key.txt" | head -n 1)
mkdir -p "$W/pitr"
chmod 755 "$W"
cat >"$W/env" <<ENV
DOMAIN=test.invalid
POSTGRES_PASSWORD=pw-test
APP_DB_PASSWORD=pw-app
BACKUP_AGE_RECIPIENT=$PUB
PITR_DIR=$W/pitr
ENV
# the compose file reads infra/deploy/.env for the app services; this test starts none of them
compose() { docker compose -p "$P" --env-file "$W/env" -f "$ROOT/infra/deploy/docker-compose.yml" "$@"; }
sql() { compose exec -T -u postgres postgres psql -U timekeeper -d timekeeper -qAtX -c "$1"; }

cleanup() {
  if [ "${KEEP:-0}" = 1 ]; then echo "kept: $W (project $P)"; return; fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm "${P}_restored" >/dev/null 2>&1 || true
  docker run --rm -v "$W":/w alpine rm -rf /w/pitr >/dev/null 2>&1 || true
  rm -rf "$W"
}
trap cleanup EXIT

echo "== build and start"
# the volume mount needs the folder to belong to the database user (uid 999), as pitr-setup.sh does
docker run --rm -v "$W/pitr":/p alpine sh -c 'chown 999:999 /p && chmod 700 /p'
# SKIP_BUILD=1 uses an image that is already tagged timekeeper-postgres:16 (for machines that cannot reach the Debian mirrors)
if [ "${SKIP_BUILD:-0}" = 1 ]; then compose up -d --no-build postgres >/dev/null; else compose up -d --build postgres >/dev/null; fi
for _ in $(seq 1 60); do
  [ "$(compose ps --format '{{.Health}}' postgres 2>/dev/null)" = healthy ] && break
  sleep 2
done
eq "database container is healthy" healthy "$(compose ps --format '{{.Health}}' postgres)"
eq "archive_mode is on" on "$(sql 'show archive_mode')"
eq "wal_level is replica" replica "$(sql 'show wal_level')"

echo "== data, base backup, point in time, mistake"
sql "create table pitr_probe (id serial primary key, note text)" >/dev/null
sql "insert into pitr_probe (note) values ('before-base')" >/dev/null
if compose exec -T -u postgres postgres "$BIN/base-backup.sh" >"$W/base.log" 2>&1; then ok "base backup finished"; else bad "base backup failed"; cat "$W/base.log" >&2; fi
eq "one base backup catalog in the archive" 1 "$(find "$W/pitr/base" -name 'base-*.json' 2>/dev/null | wc -l | tr -d ' ')"
sql "insert into pitr_probe (note) values ('good-1'), ('good-2')" >/dev/null
sleep 2
TARGET=$(sql "select to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')||'+00'")
sleep 2
sql "insert into pitr_probe (note) values ('MISTAKE')" >/dev/null
sql "delete from pitr_probe where note='good-1'" >/dev/null
sql "select pg_switch_wal()" >/dev/null
for _ in $(seq 1 30); do
  [ "$(find "$W/pitr/wal" -name '*.gz.age' 2>/dev/null | wc -l | tr -d ' ')" -ge 2 ] && sleep 3 && break
  sleep 1
done
n=$(find "$W/pitr/wal" -name '*.gz.age' | wc -l | tr -d ' ')
if [ "$n" -ge 1 ]; then ok "encrypted WAL segments archived ($n)"; else bad "no WAL archived"; fi
eq "archiver has no failures" 0 "$(sql 'select failed_count from pg_stat_archiver')"
first=$(find "$W/pitr/wal" -name '*.gz.age' | head -n 1)
eq "archived WAL is an age file" "age-encryption.org/v1" "$(head -c 21 "$first")"
set +e
compose exec -T -u postgres postgres "$BIN/verify-backups.sh" >"$W/verify.json" 2>&1
vrc=$?
set -e
echo "  verify-backups: $(jq -r '.status' "$W/verify.json" 2>/dev/null || echo unparsable) (exit $vrc)"
if [ "$vrc" -le 1 ]; then ok "verify-backups.sh is not CRIT"; else bad "verify-backups.sh CRIT"; cat "$W/verify.json" >&2; fi

echo "== (1) side restore to $TARGET"
if docker run --rm --user postgres -v "$W/pitr":/pitr:ro -v "$W/key.txt":/key.txt:ro \
  -e BACKUP_REMOTE=/pitr -e BACKUP_AGE_RECIPIENT="$PUB" -e PGUSER=timekeeper "$IMAGE" bash -c "
  $BIN/restore-pitr.sh --target-time '$TARGET' --data-dir /tmp/side --port 5499 --identity /key.txt >/tmp/r.log 2>&1 || { cat /tmp/r.log; exit 1; }
  psql -h /tmp -p 5499 -U timekeeper -d timekeeper -qAtX -c \"select string_agg(note, ',' order by id) from pitr_probe\"
  pg_ctl -D /tmp/side stop -m fast >/dev/null" >"$W/side.out" 2>&1; then
  side=$(tail -n 1 "$W/side.out")
else
  side="restore failed"
  cat "$W/side.out" >&2
fi
eq "side restore holds the data from before the mistake" "before-base,good-1,good-2" "$side"

echo "== (2) disaster: destroy the production volume and restore into it"
compose stop postgres >/dev/null
compose rm -f postgres >/dev/null
docker volume rm "${P}_pgdata" >/dev/null
docker volume create --label "com.docker.compose.project=$P" --label com.docker.compose.volume=pgdata "${P}_pgdata" >/dev/null
if docker run --rm --user postgres -v "${P}_pgdata":/var/lib/postgresql/data -v "$W/pitr":/pitr:ro -v "$W/key.txt":/key.txt:ro \
  -e BACKUP_REMOTE=/pitr -e BACKUP_AGE_RECIPIENT="$PUB" -e PGUSER=timekeeper -e BACKUP_PROD_DATA_DIR=/var/lib/postgresql/data "$IMAGE" bash -c "
  $BIN/restore-pitr.sh --target-time '$TARGET' --data-dir /var/lib/postgresql/data --port 5499 --identity /key.txt --force --i-am-sure --enable-archiving >/tmp/r.log 2>&1 || { cat /tmp/r.log; exit 1; }
  pg_ctl -D /var/lib/postgresql/data stop -m fast >/dev/null"; then ok "restore into the empty production volume finished"; else bad "restore into the production volume failed"; fi
compose up -d postgres >/dev/null
for _ in $(seq 1 60); do
  [ "$(compose ps --format '{{.Health}}' postgres 2>/dev/null)" = healthy ] && break
  sleep 2
done
eq "restored production database is healthy" healthy "$(compose ps --format '{{.Health}}' postgres)"
eq "restored data is the state before the mistake" "before-base,good-1,good-2" "$(sql "select string_agg(note, ',' order by id) from pitr_probe")"
eq "the database accepts writes again" 1 "$(sql "with i as (insert into pitr_probe (note) values ('after-restore') returning 1) select count(*) from i")"
sql "select pg_switch_wal()" >/dev/null
sleep 8
eq "archiving continues on the new timeline" 0 "$(sql 'select failed_count from pg_stat_archiver')"
tl=$(sql "select timeline_id from pg_control_checkpoint()")
eq "the restore started a new timeline" 2 "$tl"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
