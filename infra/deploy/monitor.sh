#!/usr/bin/env bash
# Health check for the pilot server, run by cron every 5 minutes (see monitor-setup.sh). Checks: the site answers over
# HTTPS, every container is running, the disk is not nearly full, memory and CPU are not exhausted, and the newest backup is recent.
# It sends a message to ALERT_WEBHOOK (a Telegram / Slack / Discord / ntfy URL, see docs/operations/monitoring-and-incidents.md)
# when something turns bad, a reminder every 6 hours while it stays bad, and a message when it recovers.
# A server that is completely down cannot report itself: also add the free external check described in that document.
set -euo pipefail

CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
STATE=${MONITOR_STATE:-/var/lib/timekeeper-monitor.state}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/timekeeper}
COMPOSE=(docker compose --env-file "$REPO_DIR/infra/deploy/.env" -f "$REPO_DIR/infra/deploy/docker-compose.yml")
DOMAIN=$(grep '^DOMAIN=' "$REPO_DIR/infra/deploy/.env" | cut -d= -f2)

problems=()

if ! curl -fsS -m 15 -o /dev/null "https://$DOMAIN/v1/health"; then
  problems+=("the site https://$DOMAIN does not answer")
fi

for service in postgres api worker web caddy; do
  if [ -z "$("${COMPOSE[@]}" ps --status running --quiet "$service" 2>/dev/null)" ]; then
    problems+=("container $service is not running")
  fi
done

used=$(df --output=pcent / | tail -n 1 | tr -dc '0-9')
if [ "${used:-0}" -ge "${MONITOR_DISK_PERCENT:-85}" ]; then
  problems+=("disk is ${used}% full")
fi

# Memory, swap and CPU: a small server that runs out of memory kills a container (the kernel picks one) or crawls in swap.
mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
if [ $((mem_avail * 100 / mem_total)) -lt "${MONITOR_MEM_FREE_PERCENT:-10}" ]; then
  problems+=("memory is nearly used up ($((mem_avail / 1024)) MB of $((mem_total / 1024)) MB available)")
fi
swap_total=$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)
swap_free=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
if [ "$swap_total" -gt 0 ] && [ $(((swap_total - swap_free) * 100 / swap_total)) -ge "${MONITOR_SWAP_PERCENT:-60}" ]; then
  problems+=("swap is $(((swap_total - swap_free) * 100 / swap_total))% used: the server is short of memory")
fi
# 15-minute load average per CPU core above the limit (default 1.5): the server is overloaded for a long time, not just a spike.
load15=$(awk '{print $3}' /proc/loadavg)
cores=$(nproc)
if awk -v l="$load15" -v c="$cores" -v m="${MONITOR_LOAD_PER_CORE:-1.5}" 'BEGIN { exit !(l / c > m) }'; then
  problems+=("the server is overloaded (15-minute load $load15 on $cores CPU core(s))")
fi
# A container the kernel stopped for lack of memory (it restarts by itself, so nothing else shows it).
for service in postgres api worker web caddy; do
  cid=$("${COMPOSE[@]}" ps --all --quiet "$service" 2>/dev/null | head -n 1 || true)
  if [ -n "$cid" ] && [ "$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || echo false)" = true ]; then
    problems+=("container $service was stopped for running out of memory")
  fi
done

# shellcheck disable=SC2012
newest=$(ls -1t "$BACKUP_DIR"/tk-*.tar.age 2>/dev/null | head -n 1 || true)
if [ -z "$newest" ]; then
  problems+=("no backup found in $BACKUP_DIR")
elif [ $(($(date +%s) - $(stat -c %Y "$newest"))) -gt $(("${MONITOR_BACKUP_MAX_AGE_H:-26}" * 3600)) ]; then
  problems+=("the newest backup is older than ${MONITOR_BACKUP_MAX_AGE_H:-26} hours")
fi

# Point-in-time recovery archive (pitr-setup.sh): WAL arriving, a recent base backup, no gaps.
if [ -f /etc/cron.d/timekeeper-pitr ]; then
  pitr_rc=0
  pitr=$("${COMPOSE[@]}" exec -T -u postgres postgres /opt/timekeeper/infra/backup/bin/verify-backups.sh 2>/dev/null) || pitr_rc=$?
  if [ "$pitr_rc" -ne 0 ]; then
    detail=$(jq -r '.checks | to_entries | map(select(.value.status != "OK") | .key + " " + .value.detail) | join(", ")' <<<"$pitr" 2>/dev/null || true)
    problems+=("database point-in-time archive: ${detail:-check could not run}")
  fi
fi

# A nightly backup that saved the database but not the uploaded files says so in .last-status.
if [ -f "$BACKUP_DIR/.last-status" ] && [ "$(cut -d' ' -f1 "$BACKUP_DIR/.last-status")" = partial ]; then
  problems+=("the last backup did not include the uploaded files (see /var/log/timekeeper-backup.log)")
fi

now=$(date +%s)
last_status=ok
last_sent=0
if [ -f "$STATE" ]; then
  read -r last_status last_sent <"$STATE" || true
fi

send() {
  logger -t timekeeper-monitor "$1"
  echo "$(date -u +%FT%TZ) $1"
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 15 -H 'Content-Type: text/plain; charset=utf-8' --data-binary "Timekeeper: $1" "$ALERT_WEBHOOK" >/dev/null || true
  fi
}

if [ ${#problems[@]} -eq 0 ]; then
  if [ "$last_status" != ok ]; then
    send "RECOVERED: everything is fine again"
  fi
  echo "ok $now" >"$STATE"
else
  text=$(IFS=';'; echo "${problems[*]}")
  if [ "$last_status" = ok ] || [ $((now - last_sent)) -ge 21600 ]; then
    send "PROBLEM: $text"
    echo "bad $now" >"$STATE"
  else
    echo "bad $last_sent" >"$STATE"
  fi
fi
