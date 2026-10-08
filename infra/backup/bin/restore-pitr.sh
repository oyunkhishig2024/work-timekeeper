#!/usr/bin/env bash
# Restore a base backup + WAL to a point in time (or to the end of the archive) and start the
# restored cluster. Works as root (files are handed to the postgres user) or as the postgres user.
#
#   restore-pitr.sh (--target-time "2026-10-08 09:30:00+08" | --latest)
#                   --data-dir DIR --port N
#                   [--base LABEL|latest|auto] [--identity FILE] [--pause]
#                   [--force] [--i-am-sure] [--enable-archiving]
#                   [--socket-dir DIR] [--timeout SECONDS] [--no-start]
#
#  --base auto (default) picks the newest base backup that finished BEFORE the target time
#         ("latest" with --target-time earlier than that base fails: PostgreSQL cannot go back).
#  --pause  stop at the target and stay in recovery (read-only) so you can inspect the data;
#           continue with: psql -p PORT -c 'select pg_wal_replay_resume()'  (promotes)
#  --force  allow a non-empty --data-dir (its contents are deleted first)
#  --i-am-sure  required for port 5432 or when --data-dir is the production data directory
#  --enable-archiving  keep archive_mode as configured (disaster recovery that becomes the new
#           production). Default: archive_mode=off so a rehearsal can never write to the real archive.
#
# Exit: 0 restored and running | 10 usage/refused | 11 failure
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

target="" latest=0 data="" port="" base=auto identity="" pause=0 force=0 sure=0 enable_arch=0
sockdir="" timeout_s=21600 nostart=0
while [ $# -gt 0 ]; do
  case $1 in
    --target-time) target=$2; shift 2 ;;
    --latest) latest=1; shift ;;
    --data-dir) data=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    --identity) identity=$2; shift 2 ;;
    --socket-dir) sockdir=$2; shift 2 ;;
    --timeout) timeout_s=$2; shift 2 ;;
    --pause) pause=1; shift ;;
    --force) force=1; shift ;;
    --i-am-sure) sure=1; shift ;;
    --enable-archiving) enable_arch=1; shift ;;
    --no-start) nostart=1; shift ;;
    -h | --help) sed -n '2,24p' "$0"; exit 0 ;;
    *) tk_die 10 "unknown option $1 (see --help)" ;;
  esac
done

[ -n "$data" ] && [ -n "$port" ] || tk_die 10 "--data-dir and --port are required"
[[ $port =~ ^[0-9]+$ ]] || tk_die 10 "--port must be a number"
if [ -n "$target" ] && [ "$latest" -eq 1 ]; then tk_die 10 "use either --target-time or --latest"; fi
if [ -z "$target" ] && [ "$latest" -eq 0 ]; then tk_die 10 "give --target-time \"YYYY-MM-DD HH:MM:SS+TZ\" or --latest"; fi
if [ "$latest" -eq 1 ] && [ "$pause" -eq 1 ]; then tk_die 10 "--pause needs --target-time"; fi
case "$data$target" in *"'"*) tk_die 10 "quotes are not allowed in paths or the target time" ;; esac

tk_load_env
tk_require_remote
tk_require_cmd age gzip sha256sum jq tar
[ -n "$identity" ] || identity="${BACKUP_AGE_IDENTITY:-}"
[ -n "$identity" ] && [ -r "$identity" ] || tk_die 10 "age private key (identity) file not readable: use --identity FILE / нууц түлхүүр уншигдахгүй"
identity=$(realpath "$identity")
pgbin="$BACKUP_PG_BIN"
[ -x "$pgbin/pg_ctl" ] || tk_die 10 "PostgreSQL binaries not found in $pgbin"
pguser=${BACKUP_PG_USER:-postgres}

if [ -n "$target" ]; then
  target_epoch=$(date -d "$target" +%s 2>/dev/null) || tk_die 10 "cannot parse --target-time '$target' (use e.g. \"2026-10-08 09:30:00+08\")"
fi

# --- safety checks BEFORE anything is touched -----------------------------------------------
data=$(realpath -m "$data")
if { [ "$port" = "5432" ] || [ "$data" = "$(realpath -m "$BACKUP_PROD_DATA_DIR")" ]; } && [ "$sure" -ne 1 ]; then
  tk_die 10 "REFUSED: port 5432 / the production data directory needs --i-am-sure. Rehearsals and side restores must use another directory and port. / Үйлдвэрлэлийн сан руу --i-am-sure-гүйгээр сэргээхгүй"
fi
if [ -e "$data/postmaster.pid" ] && kill -0 "$(head -1 "$data/postmaster.pid")" 2>/dev/null; then
  tk_die 10 "REFUSED: a PostgreSQL server is running in $data. Stop it first."
fi
if [ -d "$data" ] && [ -n "$(ls -A "$data" 2>/dev/null)" ] && [ "$force" -ne 1 ]; then
  tk_die 10 "REFUSED: $data is not empty (use --force to delete its contents) / хавтас хоосон биш"
fi
if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  tk_die 10 "REFUSED: something already listens on port $port"
fi
[ -n "$sockdir" ] || { [ "$port" = "5432" ] && sockdir=/var/run/postgresql || sockdir=/tmp; }

as_pg() { # run a command as the postgres user when we are root
  if [ "$(id -u)" -eq 0 ]; then runuser -u "$pguser" -- "$@"; else "$@"; fi
}

t0=$(date +%s)
# --- choose the base backup --------------------------------------------------------------------
work="$data.restore-work"
rm -rf "$work"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT
mapfile -t catalogs < <(remote_list base | cut -f1 | grep -E '^base-[0-9]{8}T[0-9]{6}Z\.json$' | sort -r || true)
[ "${#catalogs[@]}" -gt 0 ] || tk_die 11 "no base backups found in the remote"
chosen=""
for c in "${catalogs[@]}"; do
  remote_get "base/$c" "$work/c.json" || continue
  l=$(jq -r .label "$work/c.json")
  [ "$(jq -r '.verified // false' "$work/c.json")" = "true" ] || continue
  case $base in
    latest) chosen=$l ;;
    auto)
      if [ "$latest" -eq 1 ] || [ "$(jq -r .finished_epoch "$work/c.json")" -le "$target_epoch" ]; then chosen=$l; fi
      ;;
    *) [ "$l" = "$base" ] && chosen=$l ;;
  esac
  if [ -n "$chosen" ]; then
    cp "$work/c.json" "$work/chosen.json"
    break
  fi
done
[ -n "$chosen" ] || tk_die 11 "no suitable verified base backup (base='$base'). For a target time use --base auto: a base must finish before the target."
tk_log info "using base backup $chosen / $chosen ашиглаж байна"

# --- fetch, verify checksum, decrypt, unpack ---------------------------------------------------
remote_get "base/base-$chosen.tar.age" "$work/base.age" || tk_die 11 "download failed"
[ "$(tk_sha256 "$work/base.age")" = "$(jq -r .sha256 "$work/chosen.json")" ] || tk_die 11 "checksum of the encrypted base backup does not match the catalog: file corrupted"
mkdir -p "$work/x"
tk_age_decrypt "$identity" <"$work/base.age" | tar -xf - -C "$work/x" || tk_die 11 "decrypt/unpack failed (wrong key?) / тайлж чадсангүй (түлхүүр буруу?)"
rm -f "$work/base.age"

if [ -d "$data" ]; then find "$data" -mindepth 1 -delete; fi
mkdir -p "$data"
tar -xzf "$work/x/base.tar.gz" -C "$data"
mkdir -p "$data/pg_wal"
tar -xzf "$work/x/pg_wal.tar.gz" -C "$data/pg_wal"
cp "$work/x/backup_manifest" "$data/backup_manifest"
if [ -f "$work/x/config.tar.gz" ]; then
  mkdir -p "$data.config-from-backup"
  tar -xzf "$work/x/config.tar.gz" -C "$data.config-from-backup"
  tk_log info "server configuration of the source saved in $data.config-from-backup (not used automatically)"
fi
shopt -s nullglob
for t in "$work"/x/*.tar.gz; do
  case $(basename "$t") in base.tar.gz | pg_wal.tar.gz | config.tar.gz) ;; *) tk_log warning "tablespace archive $(basename "$t") was NOT restored - handle manually" ;; esac
done
shopt -u nullglob
rm -rf "$work/x"

# minimal config files if the backup came from a layout with config outside the data dir (Debian)
[ -f "$data/postgresql.conf" ] || printf "# generated by restore-pitr.sh - production settings are in %s.config-from-backup\nlisten_addresses = 'localhost'\n" "$data" >"$data/postgresql.conf"
[ -f "$data/pg_hba.conf" ] || printf 'local all all peer\nhost all all 127.0.0.1/32 scram-sha-256\n' >"$data/pg_hba.conf"
[ -f "$data/pg_ident.conf" ] || : >"$data/pg_ident.conf"

# --- recovery configuration --------------------------------------------------------------------
renv="$data/tk-restore.env"
{
  echo "BACKUP_REMOTE='$BACKUP_REMOTE'"
  echo "BACKUP_AGE_IDENTITY='$identity'"
  echo "BACKUP_RCLONE_FLAGS='$BACKUP_RCLONE_FLAGS'"
  [ -z "${RCLONE_CONFIG:-}" ] || echo "RCLONE_CONFIG='$RCLONE_CONFIG'"
  [ -z "${PATH:-}" ] || echo "PATH='$PATH'"
} >"$renv"
chmod 640 "$renv"
{
  echo "# BEGIN tk-restore (managed by restore-pitr.sh)"
  echo "restore_command = 'TK_BACKUP_ENV=$renv $here/wal-fetch.sh \"%f\" \"%p\"'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_inclusive = on"
    if [ "$pause" -eq 1 ]; then echo "recovery_target_action = 'pause'"; else echo "recovery_target_action = 'promote'"; fi
  fi
  echo "# END tk-restore"
} >>"$data/postgresql.auto.conf"
touch "$data/recovery.signal"
chmod 700 "$data"
[ "$(id -u)" -ne 0 ] || chown -R "$pguser":"$(id -gn "$pguser")" "$data" "$data.config-from-backup" 2>/dev/null || true

if [ "$nostart" -eq 1 ]; then
  echo "Prepared $data (not started). Start with: pg_ctl -D $data start"
  exit 0
fi

# --- start and wait ----------------------------------------------------------------------------
opts="-c port=$port -c unix_socket_directories=$sockdir -c listen_addresses=localhost"
[ "$enable_arch" -eq 1 ] || opts="$opts -c archive_mode=off"
log="$data/restore-postgres.log"
tk_log info "starting the restored cluster on port $port; WAL replay can take a long time / сэргээж эхэллээ"
if ! as_pg "$pgbin/pg_ctl" -D "$data" -l "$log" -o "$opts" -w -t "$timeout_s" start >/dev/null; then
  echo "---- last lines of $log ----" >&2
  tail -n 25 "$log" >&2 || true
  tk_die 11 "the restored server did not start / recovery failed (see above: target beyond the archive? WAL missing? wrong key?)"
fi
psql_q() { as_pg "$pgbin/psql" -h "$sockdir" -p "$port" -U "$pguser" -d postgres -qAtX -c "$1"; }
deadline=$(($(date +%s) + timeout_s))
while :; do
  if ! as_pg "$pgbin/pg_ctl" -D "$data" status >/dev/null 2>&1; then
    tail -n 25 "$log" >&2 || true
    tk_die 11 "the server stopped during recovery (see $log)"
  fi
  if [ "$pause" -eq 1 ]; then
    st=$(psql_q "select pg_get_wal_replay_pause_state()" 2>/dev/null || true)
    [ "$st" = "paused" ] && break
  else
    st=$(psql_q "select pg_is_in_recovery()" 2>/dev/null || true)
    [ "$st" = "f" ] && break
  fi
  [ "$(date +%s)" -lt "$deadline" ] || tk_die 11 "timeout waiting for recovery to finish"
  sleep 1
done

if [ "$pause" -eq 0 ]; then # recovery settings are no longer needed once promoted
  sed -i '/^# BEGIN tk-restore/,/^# END tk-restore/d' "$data/postgresql.auto.conf"
  rm -f "$renv"
fi
dur=$(($(date +%s) - t0))
cat <<MSG

RESTORE COMPLETE in ${dur}s (base $chosen, $( [ -n "$target" ] && echo "target $target" || echo "end of archive" ))
Сэргээлт дууслаа / Restored cluster: $data  port $port  socket $sockdir
Verify / Шалгах:
  psql -h $sockdir -p $port -U $pguser -d postgres -c "select now(), pg_is_in_recovery(), pg_last_xact_replay_timestamp()"
  psql -h $sockdir -p $port -U $pguser -d <database> -c "select count(*) from <table>"
  $pgbin/pg_controldata $data | grep -E 'Latest checkpoint|TimeLineID'
$( [ "$pause" -eq 1 ] && echo "Paused at the target. Inspect, then: psql -h $sockdir -p $port -c 'select pg_wal_replay_resume()'  (this promotes)" )
Stop it with: $pgbin/pg_ctl -D $data stop     Log: $log
MSG
echo "RESTORE_SECONDS=$dur"
exit 0
