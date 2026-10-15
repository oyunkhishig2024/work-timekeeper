#!/usr/bin/env bash
# Weekly usage summary for the owner (cron, Monday morning; installed by monitor-setup.sh): how big each organization is, how
# much it was used, how fast the database and the backup archive grow, and when the disk would fill at that pace. Sent to
# ALERT_WEBHOOK like the monitor's messages, and printed. Read-only.
#   sudo bash infra/deploy/usage-report.sh
set -euo pipefail

CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
REPO_DIR=${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
STATE=${USAGE_STATE:-/var/lib/timekeeper-usage.state}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/timekeeper}
PITR_DIR=${PITR_DIR:-/var/backups/timekeeper-pitr}
COMPOSE=(docker compose --env-file "$REPO_DIR/infra/deploy/.env" -f "$REPO_DIR/infra/deploy/docker-compose.yml")

sql() { "${COMPOSE[@]}" exec -T postgres psql -U timekeeper -d timekeeper -At -F ' | ' -c "$1"; }

report=()
add() { report+=("$1"); }

add "Timekeeper weekly usage ($(date -u +%F))"
add ""
add "Organizations (employees now | events in 7 days | last event, Ulaanbaatar):"
while IFS= read -r line; do
  [ -n "$line" ] && add "  $line"
done < <(sql "SELECT t.code || ' ' || lower(t.status), (SELECT count(*) FROM employee e WHERE e.tenant_id = t.id AND e.status = 'ACTIVE'),
                     (SELECT count(*) FROM device_event d WHERE d.tenant_id = t.id AND d.received_at > now() - interval '7 days'),
                     coalesce((SELECT to_char(max(received_at) AT TIME ZONE 'Asia/Ulaanbaatar', 'MM-DD HH24:MI') FROM device_event d WHERE d.tenant_id = t.id), '-')
                FROM tenant t ORDER BY t.code")

db_bytes=$(sql "SELECT pg_database_size('timekeeper')")
db_mb=$((db_bytes / 1048576))
add ""
add "Database: ${db_mb} MB. Biggest tables:"
while IFS= read -r line; do
  [ -n "$line" ] && add "  $line"
done < <(sql "SELECT c.relname || ' ' || pg_size_pretty(pg_total_relation_size(c.oid))
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'r' AND n.nspname = 'public'
                ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 3")

disk_free_mb=$(df -m --output=avail / | tail -n 1 | tr -dc '0-9')
disk_used=$(df --output=pcent / | tail -n 1 | tr -dc '0-9')
archive_mb=$(du -sm "$PITR_DIR" 2>/dev/null | cut -f1 || echo 0)
backups_mb=$(du -sm "$BACKUP_DIR" 2>/dev/null | cut -f1 || echo 0)
docker_cache=$(docker system df --format '{{.Type}} {{.Size}}' 2>/dev/null | awk '$1 == "Build" {print $3}' || true)
add ""
add "Disk: ${disk_used}% used, ${disk_free_mb} MB free. Backups: ${backups_mb} MB, point-in-time archive: ${archive_mb:-0} MB. Docker build cache: ${docker_cache:-?}."

# Growth since last week (database + both backup folders): when would the free space run out at this pace?
total_now=$((db_mb + ${archive_mb:-0} + ${backups_mb:-0}))
if [ -f "$STATE" ]; then
  read -r total_before when_before <"$STATE" || true
  days=$((($(date +%s) - ${when_before:-0}) / 86400))
  if [ "${days:-0}" -ge 1 ] && [ "$total_now" -gt "${total_before:-0}" ]; then
    per_week=$(((total_now - total_before) * 7 / days))
    if [ "$per_week" -gt 0 ]; then
      add "Growth: about ${per_week} MB a week; the disk would be full in about $((disk_free_mb / per_week)) weeks at this pace."
    fi
  fi
fi
echo "$total_now $(date +%s)" >"$STATE" 2>/dev/null || true

mem_total=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)
mem_avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
add "Memory: ${mem_avail} MB available of ${mem_total} MB. Load (15 min): $(awk '{print $3}' /proc/loadavg) on $(nproc) CPU core(s)."

logs=$("${COMPOSE[@]}" logs --no-log-prefix --since 168h api 2>/dev/null || true)
limited=$(grep -c 'limit.device_rate' <<<"$logs" || true)
refused=$(grep -c 'security.request_refused' <<<"$logs" || true)
add "Refused calls in 7 days: ${limited} phone limits, ${refused} blocked addresses."

text=$(printf '%s\n' "${report[@]}")
echo "$text"
if [ -n "${ALERT_WEBHOOK:-}" ]; then
  curl -fsS -m 15 -H 'Content-Type: text/plain; charset=utf-8' -H 'Title: Timekeeper weekly usage' --data-binary "$text" "$ALERT_WEBHOOK" >/dev/null || true
fi
