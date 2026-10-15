#!/usr/bin/env bash
# One-time: runs monitor.sh every 5 minutes and sets the alert address.
#   sudo bash infra/deploy/monitor-setup.sh 'https://ntfy.sh/your-secret-topic'
# The argument is where messages go (Telegram / Slack / Discord / ntfy URL, see docs/operations/monitoring-and-incidents.md).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
CONF=/etc/timekeeper-backup.env

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/deploy/monitor-setup.sh '<alert url>'" >&2
  exit 1
fi
if [ ! -f "$CONF" ]; then
  echo "Run infra/deploy/backup-setup.sh first (it creates $CONF)." >&2
  exit 1
fi
if [ $# -ge 1 ]; then
  grep -v '^ALERT_WEBHOOK=' "$CONF" >"$CONF.new" || true
  echo "ALERT_WEBHOOK=$1" >>"$CONF.new"
  chmod 600 "$CONF.new"
  mv "$CONF.new" "$CONF"
fi

cat >/etc/cron.d/timekeeper-monitor <<CRON
*/5 * * * * root bash $ROOT/infra/deploy/monitor.sh >>/var/log/timekeeper-monitor.log 2>&1
CRON
chmod 644 /etc/cron.d/timekeeper-monitor

# Weekly usage summary (Monday 02:30 UTC = 10:30 in Ulaanbaatar), sent to the same alert address.
cat >/etc/cron.d/timekeeper-usage <<CRON
30 2 * * 1 root bash $ROOT/infra/deploy/usage-report.sh >>/var/log/timekeeper-usage.log 2>&1
CRON
chmod 644 /etc/cron.d/timekeeper-usage

# Safety net for the disk: build cache older than 3 days is removed every Sunday (update.sh already cleans after each update).
cat >/etc/cron.d/timekeeper-docker-clean <<CRON
15 3 * * 0 root docker builder prune -f --filter until=72h >>/var/log/timekeeper-docker-clean.log 2>&1
CRON
chmod 644 /etc/cron.d/timekeeper-docker-clean

echo "Checking now:"
bash "$ROOT/infra/deploy/monitor.sh"
echo "Done. A test message is sent only when something is wrong; to test the alert address run:"
echo "  curl -d 'test' '<alert url>'"
