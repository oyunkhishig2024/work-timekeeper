#!/usr/bin/env bash
# One-time (safe to repeat): prepares point-in-time recovery of the database. Run it AFTER backup-setup.sh and BEFORE the
# rebuild that switches the database container to the image with the backup tools:
#   sudo bash infra/deploy/pitr-setup.sh
# It reuses the age PUBLIC key of the nightly backup (so the one private key you keep off the server opens everything),
# creates the archive folder, and installs the schedule: a tiny heartbeat every 4 minutes, a base backup every night,
# old-backup cleanup every morning. The monitor (monitor.sh) reports when archiving falls behind.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
ENV_FILE=infra/deploy/.env
BACKUP_CONF=/etc/timekeeper-backup.env
PITR_DIR=${PITR_DIR:-/var/backups/timekeeper-pitr}

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash infra/deploy/pitr-setup.sh" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
[ -f "$BACKUP_CONF" ] || { echo "Run backup-setup.sh first (it creates the backup key)." >&2; exit 1; }

recipient=$(grep '^BACKUP_AGE_RECIPIENT=' "$BACKUP_CONF" | cut -d= -f2-)
[ -n "$recipient" ] || { echo "No BACKUP_AGE_RECIPIENT in $BACKUP_CONF" >&2; exit 1; }
if ! grep -q '^BACKUP_AGE_RECIPIENT=' "$ENV_FILE"; then
  echo "BACKUP_AGE_RECIPIENT=$recipient" >>"$ENV_FILE"
  echo "Added BACKUP_AGE_RECIPIENT (public key) to $ENV_FILE"
fi
if [ "$PITR_DIR" != /var/backups/timekeeper-pitr ] && ! grep -q '^PITR_DIR=' "$ENV_FILE"; then
  echo "PITR_DIR=$PITR_DIR" >>"$ENV_FILE"
fi

# The database user inside the container (uid 999) writes here. Mode 700: nobody else on the server reads it.
mkdir -p "$PITR_DIR"
chown 999:999 "$PITR_DIR"
chmod 700 "$PITR_DIR"

COMPOSE="docker compose --env-file $ROOT/$ENV_FILE -f $ROOT/infra/deploy/docker-compose.yml"
BIN=/opt/timekeeper/infra/backup/bin
cat >/etc/cron.d/timekeeper-pitr <<CRON
# Point-in-time recovery of the database (infra/backup). Logs: /var/log/timekeeper-pitr.log
*/4 * * * * root $COMPOSE exec -T -u postgres postgres $BIN/wal-heartbeat.sh >>/var/log/timekeeper-pitr.log 2>&1
50 2 * * * root $COMPOSE exec -T -u postgres postgres $BIN/base-backup.sh >>/var/log/timekeeper-pitr.log 2>&1
30 5 * * * root $COMPOSE exec -T -u postgres postgres $BIN/retention.sh >>/var/log/timekeeper-pitr.log 2>&1
CRON
chmod 644 /etc/cron.d/timekeeper-pitr

echo "Ready. Next: rebuild the stack (it restarts the database for a few seconds), then take the first base backup:"
echo "  $COMPOSE up -d --build"
echo "  $COMPOSE exec -T -u postgres postgres $BIN/base-backup.sh"
