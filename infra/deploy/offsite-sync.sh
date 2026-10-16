#!/usr/bin/env bash
# Copies the point-in-time archive (already encrypted) to the off-server bucket. Run by cron (offsite-setup.sh installs it):
# every 10 minutes with "recent" (files of the last 2 days), nightly with "full" (everything). Only ever adds files: nothing
# on the remote is deleted or overwritten by this script.
#   bash infra/deploy/offsite-sync.sh recent|full
set -euo pipefail

CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
MODE=${1:-recent}
PITR_DIR=${PITR_DIR:-/var/backups/timekeeper-pitr}
STATE=${OFFSITE_STATE:-/var/lib/timekeeper-offsite.state}
[ -n "${OFFSITE_PITR_REMOTE:-}" ] || exit 0

exec 9>"${OFFSITE_LOCK:-/var/lock/timekeeper-offsite.lock}"
flock -n 9 || exit 0 # a previous run is still uploading

RCLONE=(rclone)
[ -z "${RCLONE_CONFIG:-}" ] || RCLONE+=(--config "$RCLONE_CONFIG")
args=(copy "$PITR_DIR" "$OFFSITE_PITR_REMOTE" --min-age 1m --transfers 4 --retries 3 --low-level-retries 5)
[ "$MODE" = full ] || args+=(--max-age 2d)

if "${RCLONE[@]}" "${args[@]}"; then
  echo "ok $(date +%s)" >"$STATE"
else
  echo "fail $(date +%s)" >"$STATE"
  echo "$(date -u +%FT%TZ) copy to $OFFSITE_PITR_REMOTE FAILED" >&2
  exit 1
fi
