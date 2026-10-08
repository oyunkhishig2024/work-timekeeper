#!/usr/bin/env bash
# Monitoring check, Nagios-style: prints ONE JSON line, exit 0 = OK, 1 = WARN, 2 = CRIT.
#
# Checks (thresholds are env variables, defaults in brackets):
#   remote       remote reachable
#   base_age     newest base backup younger than BACKUP_MAX_BASE_AGE_H [26 h]  (older = CRIT)
#   base_verified newest catalog says verified (pg_verifybackup passed at backup time)
#   wal_age      newest archived WAL younger than 2 x archive_timeout + margin [2x240+120 s] (WARN),
#                CRIT when older than the RPO [900 s]
#   wal_gaps     no missing WAL segments from the oldest retained base to the newest segment
#                (a gap after the newest base = CRIT, a gap only before it = WARN)
#   spool        local spool below BACKUP_SPOOL_WARN_MB / BACKUP_SPOOL_MAX_MB, no conflicts parked
#   newest_file  newest archived WAL is an age file; decrypts and matches its sha256 when
#                BACKUP_AGE_IDENTITY is available (otherwise header check only)
#   archiver     (BACKUP_CHECK_LOCAL_PG=1) pg_stat_archiver is not currently failing
#   deep         result of the last --deep run
# --deep additionally downloads the newest base backup, compares its sha256 with the catalog and,
# when BACKUP_AGE_IDENTITY is available, decrypts it and runs pg_verifybackup. It is slow and
# heavy on egress: run it daily/weekly (timekeeper-backup-deep-verify.timer), ideally on a
# machine other than the database server that holds the private key.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

deep=0
[ "${1:-}" = "--deep" ] && deep=1
tk_load_env
tk_require_cmd jq
tk_require_remote

lines=()
worst=0
now=$(tk_now)
chk() { # name status detail
  lines+=("$1"$'\t'"$2"$'\t'"$3")
  case "$2" in
    WARN) if [ "$worst" -lt 1 ]; then worst=1; fi ;;
    CRIT) worst=2 ;;
  esac
}
emit() {
  local st=OK
  [ "$worst" -eq 1 ] && st=WARN
  [ "$worst" -eq 2 ] && st=CRIT
  printf '%s\n' "${lines[@]}" |
    jq -Rn --arg status "$st" --argjson ts "$now" --arg host "$(hostname)" \
      '{status:$status, host:$host, checked_at_epoch:$ts,
        checks:([inputs | split("\t") | {(.[0]): {status:.[1], detail:.[2]}}] | add)}' -c
  exit "$worst"
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
# an unexpected failure of this script must never be silent: report it as CRIT
trap 'chk internal CRIT "verify-backups.sh failed unexpectedly at line $LINENO"; emit' ERR

# --- remote + base backups ------------------------------------------------------------------
basel=$(remote_list base) || {
  chk remote CRIT "remote unreachable: $BACKUP_REMOTE / алсын хадгалалт хүрэхгүй байна"
  emit
}
walfiles=$(remote_list wal) || {
  chk remote CRIT "cannot list wal/"
  emit
}
chk remote OK "reachable"

mapfile -t catalogs < <(printf '%s\n' "$basel" | cut -f1 | grep -E '^base-[0-9]{8}T[0-9]{6}Z\.json$' | sort -r || true)
newest_label="" newest_seg="" oldest_pos=""
if [ "${#catalogs[@]}" -eq 0 ]; then
  chk base_age CRIT "no base backup in the catalog / бүрэн нөөцлөлт алга"
else
  remote_get "base/${catalogs[0]}" "$work/newest.json" || {
    chk base_age CRIT "cannot read newest catalog"
    emit
  }
  newest_label=$(jq -r .label "$work/newest.json")
  newest_seg=$(jq -r .wal_start_segment "$work/newest.json")
  fin=$(jq -r .finished_epoch "$work/newest.json")
  age=$((now - fin))
  max=$((BACKUP_MAX_BASE_AGE_H * 3600))
  if [ "$age" -gt "$max" ]; then
    chk base_age CRIT "newest base $newest_label is $((age / 3600)) h old (limit ${BACKUP_MAX_BASE_AGE_H} h) / хэт хуучин"
  else
    chk base_age OK "newest base $newest_label is $((age / 60)) min old"
  fi
  if [ "$(jq -r '.verified // false' "$work/newest.json")" = "true" ]; then
    chk base_verified OK "pg_verifybackup passed at backup time"
  else
    chk base_verified CRIT "newest base $newest_label is not marked verified"
  fi
  # catalog of the oldest retained base -> start of the chain that must be gap free
  remote_get "base/${catalogs[${#catalogs[@]} - 1]}" "$work/oldest.json" || true
  oldest_pos=$(tk_seg_pos "$(jq -r '.wal_start_segment // empty' "$work/oldest.json" 2>/dev/null || echo "$newest_seg")")
fi

# --- WAL age, gaps, newest file ---------------------------------------------------------------
declare -A have
newest_wal="" newest_mtime=0 maxpos=-1
while IFS=$'\t' read -r f mt _; do
  [[ $f =~ ^([0-9A-F]{24})\.gz\.age$ ]] || continue
  p=$(tk_seg_pos "${BASH_REMATCH[1]}")
  have[$p]=1
  [ "$p" -gt "$maxpos" ] && maxpos=$p
done <<<"$walfiles"
while IFS=$'\t' read -r f mt _; do
  [[ $f =~ \.gz\.age$ ]] || continue
  if [ "$mt" -gt "$newest_mtime" ]; then
    newest_mtime=$mt
    newest_wal=$f
  fi
done <<<"$walfiles"

if [ -z "$newest_wal" ]; then
  chk wal_age CRIT "no archived WAL at all / WAL архив алга"
else
  wage=$((now - newest_mtime))
  [ "$wage" -lt 0 ] && wage=0
  warn=$((2 * BACKUP_ARCHIVE_TIMEOUT_S + BACKUP_WAL_MARGIN_S))
  if [ "$wage" -gt "$BACKUP_RPO_S" ]; then
    chk wal_age CRIT "newest WAL $newest_wal is ${wage}s old, over the RPO of ${BACKUP_RPO_S}s / RPO хэтэрсэн"
  elif [ "$wage" -gt "$warn" ]; then
    chk wal_age WARN "newest WAL $newest_wal is ${wage}s old (warn at ${warn}s)"
  else
    chk wal_age OK "newest WAL $newest_wal is ${wage}s old"
  fi
fi

if [ -n "$oldest_pos" ] && [ "$maxpos" -ge 0 ]; then
  newest_base_pos=$(tk_seg_pos "$newest_seg")
  missing_new=() missing_old=()
  for ((p = oldest_pos; p <= maxpos; p++)); do
    [ -n "${have[$p]:-}" ] && continue
    if [ "$p" -ge "$newest_base_pos" ]; then missing_new+=("$p"); else missing_old+=("$p"); fi
  done
  if [ "$maxpos" -lt "$newest_base_pos" ]; then
    chk wal_gaps CRIT "no WAL archived at or after the newest base's start segment $newest_seg"
  elif [ "${#missing_new[@]}" -gt 0 ]; then
    chk wal_gaps CRIT "${#missing_new[@]} WAL segment(s) missing after the newest base (first position ${missing_new[0]}, e.g. $(tk_seg_name 1 "${missing_new[0]}" | cut -c9-)): point-in-time recovery is BROKEN / WAL дутуу"
  elif [ "${#missing_old[@]}" -gt 0 ]; then
    chk wal_gaps WARN "${#missing_old[@]} WAL segment(s) missing before the newest base: only older base backups are affected"
  else
    chk wal_gaps OK "no gaps from $(tk_seg_name 1 "$oldest_pos" | cut -c9-) to position $maxpos"
  fi
fi

# --- spool ----------------------------------------------------------------------------------
if [ -d "$BACKUP_SPOOL_DIR" ]; then
  kb=$(du -sk "$BACKUP_SPOOL_DIR" | cut -f1)
  mb=$((kb / 1024))
  cnt=$(find "$BACKUP_SPOOL_DIR" -maxdepth 1 -name '*.gz.age' | wc -l)
  conf=$(find "$BACKUP_SPOOL_DIR/conflict" -type f 2>/dev/null | wc -l || true)
  if [ "$conf" -gt 0 ]; then
    chk spool CRIT "$conf conflicting WAL file(s) parked in $BACKUP_SPOOL_DIR/conflict (a different file with the same name exists remotely)"
  elif [ "$BACKUP_SPOOL_MAX_MB" -gt 0 ] && [ "$mb" -ge "$BACKUP_SPOOL_MAX_MB" ]; then
    chk spool CRIT "spool FULL: ${mb} MB / ${BACKUP_SPOOL_MAX_MB} MB, $cnt file(s) waiting / спүүл дүүрсэн"
  elif [ "$mb" -ge "$BACKUP_SPOOL_WARN_MB" ]; then
    chk spool WARN "spool ${mb} MB (warn at ${BACKUP_SPOOL_WARN_MB} MB), $cnt file(s) waiting"
  else
    chk spool OK "spool ${mb} MB, $cnt file(s) waiting"
  fi
else
  chk spool OK "no spool directory yet"
fi

# --- newest file: encrypted? decrypts? ------------------------------------------------------
if [ -n "$newest_wal" ]; then
  if remote_get "wal/$newest_wal" "$work/w.age"; then
    hdr=$(head -c 21 "$work/w.age" || true)
    if [ "$hdr" != "age-encryption.org/v1" ]; then
      chk newest_file CRIT "$newest_wal is NOT an age-encrypted file"
    elif [ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -r "${BACKUP_AGE_IDENTITY}" ]; then
      stem=${newest_wal%.gz.age}
      if tk_age_decrypt "$BACKUP_AGE_IDENTITY" <"$work/w.age" | gzip -dc >"$work/w.plain" 2>/dev/null; then
        if remote_get "wal/$stem.sha256" "$work/w.sha" 2>/dev/null && [ "$(tk_sha256 "$work/w.plain")" != "$(cat "$work/w.sha")" ]; then
          chk newest_file CRIT "$newest_wal decrypts but its checksum does not match"
        else
          chk newest_file OK "$newest_wal is encrypted, decrypts and matches its checksum"
        fi
      else
        chk newest_file CRIT "$newest_wal does not decrypt with the configured identity / тайлж чадсангүй"
      fi
    else
      chk newest_file OK "$newest_wal is age-encrypted (decrypt test skipped: no BACKUP_AGE_IDENTITY on this host)"
    fi
  else
    chk newest_file CRIT "cannot download $newest_wal"
  fi
fi

# --- local archiver status -------------------------------------------------------------------
if [ "${BACKUP_CHECK_LOCAL_PG:-1}" = "1" ] && [ -x "$BACKUP_PG_BIN/psql" ]; then
  if st=$(timeout 15 "$BACKUP_PG_BIN/psql" -qAtX -F ' ' -d postgres -c "select coalesce(extract(epoch from last_failed_time),0)::bigint, coalesce(extract(epoch from last_archived_time),0)::bigint, failed_count from pg_stat_archiver" 2>/dev/null); then
    read -r lf la fc <<<"$st"
    if [ "${lf:-0}" -gt "${la:-0}" ]; then
      chk archiver CRIT "PostgreSQL archive_command is currently failing (failed_count=$fc) / архивлалт алдаатай"
    else
      chk archiver OK "archiver healthy (failed_count=$fc)"
    fi
  else
    chk archiver WARN "cannot query pg_stat_archiver (database down or no access)"
  fi
fi

# --- deep verification -----------------------------------------------------------------------
deep_state="$BACKUP_STATE_DIR/deep-verify.json"
if [ "$deep" -eq 1 ] && [ -n "$newest_label" ]; then
  res=OK
  msg=""
  mkdir -p "$BACKUP_STATE_DIR" "$BACKUP_STAGING_DIR"
  if ! remote_get "base/base-$newest_label.tar.age" "$work/base.age"; then
    res=CRIT
    msg="cannot download base-$newest_label.tar.age"
  elif [ "$(tk_sha256 "$work/base.age")" != "$(jq -r .sha256 "$work/newest.json")" ]; then
    res=CRIT
    msg="sha256 of base-$newest_label.tar.age differs from the catalog (corrupted or tampered)"
  elif [ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -r "${BACKUP_AGE_IDENTITY}" ]; then
    mkdir -p "$work/x"
    if tk_age_decrypt "$BACKUP_AGE_IDENTITY" <"$work/base.age" | tar -xf - -C "$work/x" 2>/dev/null; then
      if tk_verify_pg_dir "$work/x" 2>"$work/v.err"; then
        msg="downloaded, sha256 ok, decrypted, pg_verifybackup passed"
      else
        res=CRIT
        msg="pg_verifybackup FAILED on the decrypted base backup"
      fi
    else
      res=CRIT
      msg="base backup does not decrypt/unpack with the configured identity"
    fi
  else
    msg="downloaded, sha256 ok (decrypt + pg_verifybackup skipped: no BACKUP_AGE_IDENTITY on this host)"
  fi
  jq -cn --arg r "$res" --arg m "$msg" --arg l "$newest_label" --argjson t "$now" \
    '{result:$r, detail:$m, label:$l, at_epoch:$t}' >"$deep_state" 2>/dev/null || true
fi
if [ -r "$deep_state" ]; then
  dr=$(jq -r .result "$deep_state")
  dd=$(jq -r '"\(.label): \(.detail)"' "$deep_state")
  da=$(((now - $(jq -r .at_epoch "$deep_state")) / 3600))
  if [ "$dr" = "OK" ]; then chk deep OK "last deep check ${da} h ago, $dd"; else chk deep CRIT "last deep check ${da} h ago FAILED: $dd"; fi
else
  chk deep OK "never run on this host (use --deep)"
fi

emit
