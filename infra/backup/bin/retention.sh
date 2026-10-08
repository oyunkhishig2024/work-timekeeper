#!/usr/bin/env bash
# Retention for base backups + WAL.
#  keep: newest base of each of the last 7 days (that have one), 4 ISO weeks, 3 months (UTC),
#        always the newest verified base, and every base newer than it.
#  WAL : delete archived WAL (and .backup labels) positioned before the OLDEST retained base's
#        start segment. Timeline history files are kept. Nothing is deleted when a catalog
#        cannot be read or when no verified base exists.
# Usage: retention.sh [--dry-run]       Prints one JSON summary line.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

dry=0
[ "${1:-}" = "--dry-run" ] && dry=1
tk_load_env
tk_require_remote
tk_require_cmd jq flock
mkdir -p "$BACKUP_STATE_DIR"
exec 7>"$BACKUP_STATE_DIR/retention.lock"
flock -n 7 || tk_die 75 "retention already running"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mapfile -t catalogs < <(remote_list base | cut -f1 | grep -E '^base-[0-9]{8}T[0-9]{6}Z\.json$' | sort -r || true)
declare -A day_seen week_seen month_seen
declare -A keep seg_of verified_of
nd=0 nw=0 nm=0 unsafe=0 newest_verified=""
labels=()
for c in "${catalogs[@]}"; do
  if remote_get "base/$c" "$work/c.json" && jq -e '.label and .wal_start_segment' "$work/c.json" >/dev/null 2>&1; then
    l=$(jq -r .label "$work/c.json")
    labels+=("$l")
    seg_of[$l]=$(jq -r .wal_start_segment "$work/c.json")
    verified_of[$l]=$(jq -r '.verified // false' "$work/c.json")
  else
    tk_log warning "catalog $c unreadable - retention will not delete any WAL"
    unsafe=1
  fi
done

for l in "${labels[@]}"; do # newest first
  [ "${verified_of[$l]}" = "true" ] || continue
  [ -n "$newest_verified" ] || newest_verified=$l
  d=${l:0:8}
  w=$(date -u -d "$d" +%G-%V)
  m=${l:0:6}
  if [ -z "${day_seen[$d]:-}" ] && [ "$nd" -lt "$BACKUP_KEEP_DAILY" ]; then
    keep[$l]=1
    day_seen[$d]=1
    nd=$((nd + 1))
  fi
  if [ -z "${week_seen[$w]:-}" ] && [ "$nw" -lt "$BACKUP_KEEP_WEEKLY" ]; then
    keep[$l]=1
    week_seen[$w]=1
    nw=$((nw + 1))
  fi
  if [ -z "${month_seen[$m]:-}" ] && [ "$nm" -lt "$BACKUP_KEEP_MONTHLY" ]; then
    keep[$l]=1
    month_seen[$m]=1
    nm=$((nm + 1))
  fi
done
if [ -z "$newest_verified" ]; then
  tk_log warning "no verified base backup found - nothing is deleted"
  jq -cn '{retention:"skipped", reason:"no verified base"}'
  exit 0
fi
keep[$newest_verified]=1
for l in "${labels[@]}"; do # everything newer than the newest verified base stays
  [[ $l > $newest_verified ]] && keep[$l]=1
done

deleted_bases=()
kept_bases=()
min_pos=""
for l in "${labels[@]}"; do
  if [ -n "${keep[$l]:-}" ]; then
    kept_bases+=("$l")
    p=$(tk_seg_pos "${seg_of[$l]}")
    if [ -z "$min_pos" ] || [ "$p" -lt "$min_pos" ]; then min_pos=$p; fi
  else
    deleted_bases+=("$l")
    if [ "$dry" -eq 0 ] && [ "$unsafe" -eq 0 ]; then
      remote_rm "base/base-$l.json" # catalog first: it is what makes a base "exist"
      remote_rm "base/base-$l.tar.age"
    fi
  fi
done

wal_deleted=0
if [ "$unsafe" -eq 0 ] && [ -n "$min_pos" ]; then
  while IFS=$'\t' read -r f _ _; do
    [[ $f =~ ^([0-9A-F]{24})(\..*)?\.(gz\.age|sha256)$ ]] || continue
    p=$(tk_seg_pos "${BASH_REMATCH[1]}")
    if [ "$p" -lt "$min_pos" ]; then
      [ "$dry" -eq 1 ] || remote_rm "wal/$f"
      wal_deleted=$((wal_deleted + 1))
    fi
  done < <(remote_list wal)
fi

json_arr() { if [ $# -eq 0 ]; then echo '[]'; else printf '%s\n' "$@" | jq -R . | jq -sc .; fi; }
minseg=""
[ -z "$min_pos" ] || minseg=$(tk_seg_name 0 "$min_pos" | cut -c9-)
jq -cn --argjson kept "$(json_arr "${kept_bases[@]}")" \
  --argjson deleted "$(json_arr "${deleted_bases[@]}")" \
  --argjson wal "$wal_deleted" --argjson dry "$dry" --argjson unsafe "$unsafe" --arg minseg "$minseg" \
  '{retention:"done", dry_run:($dry==1), wal_kept_from_log_seg:$minseg, kept:$kept,
    deleted_bases:$deleted, wal_files_deleted:$wal, unsafe_skip_wal:($unsafe==1)}'
