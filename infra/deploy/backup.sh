#!/usr/bin/env bash
# Nightly backup (run by cron, or by hand: sudo bash infra/deploy/backup.sh).
# Writes /var/backups/timekeeper/tk-<UTC time>.tar.age containing: the database dump, uploaded files and
# infra/deploy/.env (it holds DATA_ENCRYPTION_KEY, without which stored 2FA secrets cannot be read).
# Everything is encrypted with the public key in /etc/timekeeper-backup.env, then old backups are removed.
# Optional off-server copy: set BACKUP_REMOTE (an rclone remote) in that file.
set -euo pipefail

CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
# shellcheck disable=SC1090
. "$CONF"
: "${REPO_DIR:?REPO_DIR missing in $CONF}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT missing in $CONF}"
KEEP=${BACKUP_KEEP:-14}
DEST=${BACKUP_DIR:-/var/backups/timekeeper}
COMPOSE=(docker compose --env-file "$REPO_DIR/infra/deploy/.env" -f "$REPO_DIR/infra/deploy/docker-compose.yml")

umask 077
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$DEST" "$work/bundle"

"${COMPOSE[@]}" exec -T postgres pg_dump -U timekeeper -d timekeeper -Fc >"$work/bundle/db.dump"
[ -s "$work/bundle/db.dump" ] || { echo "$stamp backup FAILED: empty database dump" >&2; exit 1; }

# Uploaded files (signed consent scans) live in the api container's storage volume.
"${COMPOSE[@]}" exec -T api tar -C /data/storage -cf - . >"$work/bundle/storage.tar" 2>/dev/null || true
cp "$REPO_DIR/infra/deploy/.env" "$work/bundle/env"

tar -C "$work/bundle" -cf - . | age -r "$BACKUP_AGE_RECIPIENT" >"$work/tk.tar.age"
[ -s "$work/tk.tar.age" ] || { echo "$stamp backup FAILED: encryption" >&2; exit 1; }
mv "$work/tk.tar.age" "$DEST/tk-$stamp.tar.age"

# Keep the newest $KEEP backups.
# shellcheck disable=SC2012
ls -1t "$DEST"/tk-*.tar.age | tail -n "+$((KEEP + 1))" | xargs -r rm -f

if [ -n "${BACKUP_REMOTE:-}" ]; then
  rclone copyto "$DEST/tk-$stamp.tar.age" "$BACKUP_REMOTE/tk-$stamp.tar.age"
fi

size=$(du -h "$DEST/tk-$stamp.tar.age" | cut -f1)
echo "$stamp backup OK: $DEST/tk-$stamp.tar.age ($size)"
