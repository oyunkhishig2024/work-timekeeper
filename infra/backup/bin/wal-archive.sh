#!/usr/bin/env bash
# PostgreSQL archive_command target:   wal-archive.sh "%p" "%f"
#
# Pipeline per file:  gzip -> age (encrypt) -> temp name in the local spool -> fsync -> atomic
# rename -> upload to the remote (temp name + rename, or an object-store PUT).
# Encryption happens BEFORE anything leaves the server. Why age: it is public-key, so the VPS
# only holds the public key and a stolen server/backup bucket cannot decrypt anything; the
# private key stays offline (see docs/operations/backup-and-restore.md). openssl enc with a key
# file would need the decryption key ON the server.
#
# Behaviour
#  - Idempotent: archiving the same segment again with identical content returns 0.
#  - Never overwrites: a different file with the same name returns 12 (PostgreSQL retries and
#    alerts via pg_stat_archiver / verify-backups.sh); the spooled copy is parked in spool/conflict.
#  - Remote outage: the file stays in the spool (returns 0 so pg_wal does not fill up) and is
#    uploaded, oldest first, by the next call. Spool is bounded (BACKUP_SPOOL_MAX_MB); when full
#    this returns 13 so PostgreSQL keeps the WAL itself and retries. BACKUP_SPOOL_MAX_MB=0
#    disables spooling: a remote failure then returns 14.
#
# Exit codes: 0 ok | 10 config/usage | 11 local failure | 12 conflict | 13 spool full | 14 remote down, no spool
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

[ $# -eq 2 ] || {
  echo 'usage: wal-archive.sh <path (%p)> <file name (%f)>' >&2
  exit 10
}
src=$1
name=$2
case "$name" in '' | */* | .*) tk_die 10 "bad file name '$name'" ;; esac

tk_load_env
tk_require_encrypt
[ -r "$src" ] || tk_die 11 "cannot read $src"

umask 077
spool="$BACKUP_SPOOL_DIR"
mkdir -p "$spool/conflict" || tk_die 11 "spool dir $spool not writable / спүүл хавтас руу бичих боломжгүй"
exec 9>"$spool/.lock"
flock -w 300 9 || tk_die 11 "could not get the spool lock"
find "$spool" -maxdepth 1 -name '.tmp.*' -mmin +60 -delete 2>/dev/null || true

final="$spool/$name.gz.age"
tmp="$spool/.tmp.$name.$$"
trap 'rm -f -- "$tmp" "$tmp.sha"' EXIT

spool_kb() { du -sk "$spool" | cut -f1; }

plain_sha=$(tk_sha256 "$src")

# upload_one <name>: 0 uploaded or identical copy already there | 1 remote unavailable | 2 conflict
upload_one() {
  local n=$1 rc=0 sha_local sha_remote t
  sha_local=$(cat "$spool/$n.sha256")
  remote_exists "wal/$n.gz.age" || rc=$?
  case $rc in
    2) return 1 ;;
    0)
      t=$(mktemp "$spool/.tmp.sha.XXXXXX")
      if remote_get "wal/$n.sha256" "$t" 2>/dev/null; then
        sha_remote=$(cat "$t")
        rm -f "$t"
        if [ "$sha_remote" = "$sha_local" ]; then
          rm -f "$spool/$n.gz.age" "$spool/$n.sha256"
          return 0
        fi
        return 2
      fi
      rm -f "$t"
      rc=0
      remote_exists "wal/$n.sha256" || rc=$?
      [ "$rc" -eq 1 ] && return 2 # file without checksum: cannot prove it is the same
      return 1
      ;;
  esac
  # sidecar first, the .gz.age last: the .gz.age is the commit marker
  remote_put "$spool/$n.sha256" "wal/$n.sha256" || return 1
  remote_put "$spool/$n.gz.age" "wal/$n.gz.age" || return 1
  rm -f "$spool/$n.gz.age" "$spool/$n.sha256"
  return 0
}

# 1. stage the current file in the spool (crash-safe: temp name, fsync, rename)
if [ -e "$final" ]; then
  [ "$(cat "$spool/$name.sha256" 2>/dev/null || true)" = "$plain_sha" ] ||
    {
      tk_alert crit "WAL $name: different content already spooled - NOT overwritten / давхардсан өөр агуулгатай файл"
      tk_die 12 "conflict in spool for $name"
    }
else
  if [ "$BACKUP_SPOOL_MAX_MB" -gt 0 ] && [ "$(spool_kb)" -ge $((BACKUP_SPOOL_MAX_MB * 1024)) ]; then
    tk_alert crit "WAL spool is FULL (${BACKUP_SPOOL_MAX_MB} MB): remote unreachable for too long; archiving blocked / спүүл дүүрсэн"
    tk_die 13 "spool full"
  fi
  gzip -1 -n -c -- "$src" | tk_age_encrypt >"$tmp" || tk_die 11 "compress/encrypt failed for $name"
  tk_sync "$tmp"
  printf '%s\n' "$plain_sha" >"$tmp.sha"
  tk_sync "$tmp.sha"
  mv -f -- "$tmp.sha" "$spool/$name.sha256"
  mv -- "$tmp" "$final"
  tk_sync "$spool"
fi

# 2. drain the spool, oldest first (this includes the file just staged)
conflict_cur=0
while IFS= read -r f; do
  n=${f%.gz.age}
  rc=0
  upload_one "$n" || rc=$?
  case $rc in
    0) ;;
    1)
      break
      ;;
    2)
      mv -f -- "$spool/$n.gz.age" "$spool/$n.sha256" "$spool/conflict/" 2>/dev/null || true
      tk_alert crit "WAL $n differs from the archived copy - NOT overwritten / архивт байгаа файлаас өөр"
      [ "$n" = "$name" ] && conflict_cur=1
      ;;
  esac
done < <(find "$spool" -maxdepth 1 -name '*.gz.age' -printf '%f\n' | sort)

[ "$conflict_cur" -eq 0 ] || tk_die 12 "conflict for $name (existing different file kept)"

if [ -e "$final" ]; then
  if [ "$BACKUP_SPOOL_MAX_MB" -le 0 ]; then
    rm -f -- "$final" "$spool/$name.sha256"
    tk_die 14 "remote unavailable, spooling disabled; PostgreSQL will retry / алсын хадгалалт хүрэхгүй байна"
  fi
  left=$(find "$spool" -maxdepth 1 -name '*.gz.age' | wc -l)
  tk_log warning "remote unavailable: $left WAL file(s) queued in $spool ($(($(spool_kb) / 1024)) MB) / алсын хадгалалт хүрэхгүй, дараалалд байна"
  if [ "$(spool_kb)" -ge $((BACKUP_SPOOL_WARN_MB * 1024)) ]; then
    tk_alert warning "WAL spool is $(($(spool_kb) / 1024)) MB (warn at ${BACKUP_SPOOL_WARN_MB}); remote unreachable? / спүүл өсөж байна"
  fi
fi
exit 0
