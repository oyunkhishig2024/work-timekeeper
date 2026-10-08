#!/usr/bin/env bash
# Send an alert: syslog always, webhook if BACKUP_ALERT_WEBHOOK is set (Slack/Mattermost/
# Telegram-bridge style JSON {"text": ...}). Repeats of the same message are suppressed for
# BACKUP_ALERT_REPEAT_MIN minutes. Usage: alert.sh <info|warning|crit> <message>
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

[ $# -ge 2 ] || {
  echo "usage: alert.sh <severity> <message>" >&2
  exit 10
}
sev=$1
shift
msg=$*
tk_load_env

mkdir -p "$BACKUP_STATE_DIR/alerts" 2>/dev/null || true
key=$(printf '%s' "$sev$msg" | sha256sum | cut -c1-16)
marker="$BACKUP_STATE_DIR/alerts/$key"
now=$(tk_now)
if [ -f "$marker" ]; then
  last=$(stat -c %Y "$marker" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt $((BACKUP_ALERT_REPEAT_MIN * 60)) ]; then exit 0; fi
fi
touch "$marker" 2>/dev/null || true
find "$BACKUP_STATE_DIR/alerts" -type f -mtime +2 -delete 2>/dev/null || true

host=$(hostname)
logger -t timekeeper-backup-alert -p "user.${sev}" -- "[$sev] $msg" 2>/dev/null || true
if [ -n "${BACKUP_ALERT_WEBHOOK:-}" ]; then
  text="[timekeeper-backup][$sev] $host: $msg"
  curl -fsS --max-time 10 -H 'Content-Type: application/json' \
    -d "$(jq -cn --arg t "$text" '{text:$t, content:$t}')" "$BACKUP_ALERT_WEBHOOK" >/dev/null ||
    tk_log warning "webhook delivery failed"
fi
exit 0
