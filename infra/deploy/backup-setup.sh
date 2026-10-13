#!/usr/bin/env bash
# One-time: prepares encrypted nightly backups of the database and uploaded files.
#   sudo bash infra/deploy/backup-setup.sh
# Creates an age key pair. The PUBLIC key stays on the server (it can only lock backups). The PRIVATE key is
# printed once: save it somewhere that is NOT this server (password manager). Without it a backup cannot be opened.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
CONF=/etc/timekeeper-backup.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/deploy/backup-setup.sh" >&2
  exit 1
fi

if ! command -v age-keygen >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq age
fi

mkdir -p /var/backups/timekeeper
chmod 700 /var/backups/timekeeper

if [ ! -f "$CONF" ]; then
  umask 077
  # age-keygen refuses to write into a file that already exists, so use a fresh path inside a private directory.
  keydir=$(mktemp -d)
  key="$keydir/key.txt"
  if ! age-keygen -o "$key" 2>"$keydir/err"; then
    cat "$keydir/err" >&2
    rm -rf "$keydir"
    echo "Could not create the backup key." >&2
    exit 1
  fi
  pub=$(grep -o 'age1[0-9a-z]*' "$key" | head -n 1)
  if [ -z "$pub" ]; then
    rm -rf "$keydir"
    echo "Could not read the public key." >&2
    exit 1
  fi
  {
    echo "REPO_DIR=$ROOT"
    echo "BACKUP_AGE_RECIPIENT=$pub"
    echo "BACKUP_KEEP=14"
    echo "# BACKUP_REMOTE=spaces:bucket-name/timekeeper   (optional off-server copy with rclone)"
  } >"$CONF"
  echo
  echo "=============== SAVE THIS PRIVATE KEY OFF THIS SERVER (shown once) ==============="
  grep '^AGE-SECRET-KEY' "$key"
  echo "==================================================================================="
  shred -u "$key" 2>/dev/null || rm -f "$key"
  rm -rf "$keydir"
fi

cat >/etc/cron.d/timekeeper-backup <<CRON
# Nightly backup at 02:30 server time (UTC). Log: /var/log/timekeeper-backup.log
30 2 * * * root bash $ROOT/infra/deploy/backup.sh >>/var/log/timekeeper-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/timekeeper-backup

echo
echo "Running the first backup now..."
bash "$ROOT/infra/deploy/backup.sh"
