#!/usr/bin/env bash
# One-time: sends every backup to a Backblaze B2 bucket as well, so losing this server does not lose the backups.
#   sudo bash infra/deploy/offsite-setup.sh
# Asks for the bucket name, the application key ID and the application key (typed here, never in a chat). The files sent are
# already encrypted with your public key (the private key is not on this server), so the bucket only ever holds unreadable files.
# Safe to run again (it replaces the stored key).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
CONF_DIR=${OFFSITE_CONF_DIR:-/etc/timekeeper-backup}
CRON_DIR=${OFFSITE_CRON_DIR:-/etc/cron.d}
RCLONE_CONF="$CONF_DIR/rclone.conf"

if [ "$(id -u)" -ne 0 ] && [ -z "${TK_ALLOW_NONROOT:-}" ]; then
  echo "Run as root: sudo bash infra/deploy/offsite-setup.sh" >&2
  exit 1
fi
if [ ! -f "$CONF" ]; then
  echo "Run infra/deploy/backup-setup.sh first (it creates $CONF)." >&2
  exit 1
fi
if ! command -v rclone >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq rclone
fi

read -r -p "Backblaze bucket name: " bucket
read -r -p "Application key ID (keyID): " key_id
read -r -s -p "Application key (typing is hidden): " app_key
echo
if [ -z "$bucket" ] || [ -z "$key_id" ] || [ -z "$app_key" ]; then
  echo "All three are needed." >&2
  exit 1
fi

umask 077
mkdir -p "$CONF_DIR"
cat >"$RCLONE_CONF" <<RC
[b2]
type = b2
account = $key_id
key = $app_key
RC
chmod 600 "$RCLONE_CONF"
RCLONE=(rclone --config "$RCLONE_CONF")

echo "== checking the bucket"
if ! "${RCLONE[@]}" lsf "b2:$bucket" >/dev/null; then
  echo "Could not open bucket \"$bucket\" with that key. Check the bucket name and that the key is limited to this bucket (or all buckets)." >&2
  exit 1
fi
probe="offsite-test-$(date +%s)"
echo "timekeeper offsite test" | "${RCLONE[@]}" rcat "b2:$bucket/test/$probe"
if [ "$("${RCLONE[@]}" cat "b2:$bucket/test/$probe")" != "timekeeper offsite test" ]; then
  echo "Wrote a test file but could not read it back." >&2
  exit 1
fi
"${RCLONE[@]}" deletefile "b2:$bucket/test/$probe" 2>/dev/null || true
echo "The bucket accepts and returns files."

echo "== saving the settings"
tmp=$(mktemp)
grep -v -e '^BACKUP_REMOTE=' -e '^RCLONE_CONFIG=' -e '^OFFSITE_PITR_REMOTE=' "$CONF" >"$tmp" || true
{
  echo "BACKUP_REMOTE=b2:$bucket/nightly"
  echo "OFFSITE_PITR_REMOTE=b2:$bucket/pitr"
  echo "RCLONE_CONFIG=$RCLONE_CONF"
} >>"$tmp"
chmod 600 "$tmp"
mv "$tmp" "$CONF"

cat >"$CRON_DIR/timekeeper-offsite" <<CRON
# Copies the point-in-time archive to the off-server bucket: new files every 10 minutes, everything nightly. Log: /var/log/timekeeper-offsite.log
*/10 * * * * root bash $ROOT/infra/deploy/offsite-sync.sh recent >>/var/log/timekeeper-offsite.log 2>&1
40 3 * * * root bash $ROOT/infra/deploy/offsite-sync.sh full >>/var/log/timekeeper-offsite.log 2>&1
CRON
chmod 644 "$CRON_DIR/timekeeper-offsite"

if [ -z "${OFFSITE_SKIP_FIRST_RUN:-}" ]; then
  echo "== first copy of the point-in-time archive (may take a minute)"
  bash "$ROOT/infra/deploy/offsite-sync.sh" full
  echo "== first copy of a fresh nightly backup"
  bash "$ROOT/infra/deploy/backup.sh"
fi
echo "Done. Backups now also go to b2:$bucket. See them in the Backblaze web page under Buckets > Browse Files (folders nightly and pitr)."
