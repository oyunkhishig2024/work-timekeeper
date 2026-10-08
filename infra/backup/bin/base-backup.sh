#!/usr/bin/env bash
# Daily physical base backup: pg_basebackup (tar+gzip, WAL streamed, SHA-256 manifest) ->
# verify with pg_verifybackup -> one age-encrypted bundle -> upload -> catalog JSON (the commit
# marker, uploaded last) -> switch WAL -> retention. Run as the postgres OS user.
#
# Usage: base-backup.sh [--label LABEL] [--no-retention]
# Exit: 0 ok | 10 config | 11 local failure | 20 backup ok but retention failed | 75 already running
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

label=${TK_LABEL:-}
run_retention=1
while [ $# -gt 0 ]; do
  case $1 in
    --label)
      label=$2
      shift 2
      ;;
    --no-retention)
      run_retention=0
      shift
      ;;
    *)
      echo "usage: base-backup.sh [--label LABEL] [--no-retention]" >&2
      exit 10
      ;;
  esac
done

tk_load_env
tk_require_encrypt
tk_require_cmd jq tar
[ -x "$BACKUP_PG_BIN/pg_basebackup" ] || tk_die 10 "pg_basebackup not found in $BACKUP_PG_BIN"
[ -n "$label" ] || label=$(date -u +%Y%m%dT%H%M%SZ)
[[ $label =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || tk_die 10 "label must look like 20261008T183000Z"

umask 077
mkdir -p "$BACKUP_STATE_DIR" "$BACKUP_STAGING_DIR"
exec 8>"$BACKUP_STATE_DIR/base.lock"
flock -n 8 || tk_die 75 "another base backup is running"

stage="$BACKUP_STAGING_DIR/$label"
rm -rf "$stage"
mkdir -p "$stage/pg"
fail() {
  tk_alert crit "base backup $label FAILED: $* / бүрэн нөөцлөлт амжилтгүй"
  tk_die 11 "$*"
}
trap 'rm -rf "$stage"' EXIT

started=$(date -u +%FT%TZ)
tk_log info "base backup $label: pg_basebackup start / эхэллээ"
"$BACKUP_PG_BIN/pg_basebackup" -D "$stage/pg" -Ft -z -X stream -c fast -w \
  --manifest-checksums=SHA256 --label "timekeeper-$label" || fail "pg_basebackup failed"

# also keep the server configuration (it lives outside the data directory on Debian/Ubuntu)
if [ -n "${BACKUP_PG_CONF_DIR:-}" ] && [ -d "$BACKUP_PG_CONF_DIR" ]; then
  tar -czf "$stage/pg/config.tar.gz" -C "$BACKUP_PG_CONF_DIR" . 2>/dev/null || tk_log warning "config copy failed"
fi

# verify the backup BEFORE it is allowed to count (a catalog is only written after this passes)
extra=$(find "$stage/pg" -maxdepth 1 -name '*.tar.gz' ! -name base.tar.gz ! -name pg_wal.tar.gz ! -name config.tar.gz | wc -l)
[ "$extra" -eq 0 ] || tk_log warning "tablespace archives present: they are saved but not checked by pg_verifybackup"
tk_verify_pg_dir "$stage/pg" || fail "pg_verifybackup failed"

# manifest -> start position
read -r tl lsn < <(jq -r '."WAL-Ranges"[0] | "\(.Timeline) \(."Start-LSN")"' "$stage/pg/backup_manifest")
hi=$((16#${lsn%/*}))
lo=$((16#${lsn#*/}))
pos=$((hi * $(tk_seg_per_log) + lo / (BACKUP_WAL_SEG_MB * 1048576)))
seg=$(tk_seg_name "$tl" "$pos")

# one encrypted bundle
bundle="$stage/base-$label.tar.age"
tar -C "$stage/pg" -cf - . | tk_age_encrypt >"$bundle" || fail "bundle/encrypt failed"
tk_sync "$bundle"
size=$(stat -c %s "$bundle")
sha=$(tk_sha256 "$bundle")
finished=$(date -u +%FT%TZ)
finished_epoch=$(date +%s)

jq -n --arg label "$label" --arg started "$started" --arg finished "$finished" \
  --argjson fe "$finished_epoch" --argjson tl "$tl" --arg lsn "$lsn" --arg seg "$seg" \
  --arg ver "$("$BACKUP_PG_BIN/pg_basebackup" --version | awk '{print $NF}')" \
  --arg file "base-$label.tar.age" --argjson size "$size" --arg sha "$sha" --arg host "$(hostname)" \
  '{schema:1, label:$label, started_utc:$started, finished_utc:$finished, finished_epoch:$fe,
    timeline:$tl, start_lsn:$lsn, wal_start_segment:$seg, pg_version:$ver, file:$file,
    size_bytes:$size, sha256:$sha, verified:true, verified_at:$finished, host:$host,
    compression:"gzip", encryption:"age"}' >"$stage/base-$label.json"

remote_put "$bundle" "base/base-$label.tar.age" || fail "upload of the bundle failed (remote unreachable?)"
remote_put "$stage/base-$label.json" "base/base-$label.json" || fail "upload of the catalog failed"
tk_log info "base backup $label uploaded: $size bytes, WAL start $seg"

# close the current segment so the WAL up to now is archived, then wait for the spool to drain
"$BACKUP_PG_BIN/psql" -qAtX -c "select pg_switch_wal()" >/dev/null 2>&1 || tk_log warning "pg_switch_wal failed"
for _ in $(seq 1 60); do
  [ -z "$(find "$BACKUP_SPOOL_DIR" -maxdepth 1 -name '*.gz.age' 2>/dev/null | head -1)" ] && break
  sleep 2
done
date +%s >"$BACKUP_STATE_DIR/last-base-ok"

if [ "$run_retention" -eq 1 ]; then
  "$here/retention.sh" || {
    tk_alert warning "base backup $label ok, but retention failed"
    exit 20
  }
fi
tk_log info "base backup $label complete / бүрэн нөөцлөлт дууслаа"
exit 0
