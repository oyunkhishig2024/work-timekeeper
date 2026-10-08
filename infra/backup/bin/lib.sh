#!/usr/bin/env bash
# Timekeeper backup - shared helpers. Sourced by the other scripts, never executed.
# shellcheck shell=bash
#
# Configuration comes from the env file (default /etc/timekeeper-backup.env, override with
# TK_BACKUP_ENV). See infra/backup/README.md for every variable.
#
# Exit codes used across the scripts (kept below 126 on purpose: PostgreSQL treats >=126 from
# archive_command / restore_command specially):
#   0   ok
#   10  configuration / usage error          11  local spool or encryption failure
#   12  CONFLICT: a different file with the same name already exists (never overwritten)
#   13  spool full (archiving is blocked on purpose)
#   14  remote unavailable and spooling disabled
#   20  base backup uploaded but retention failed

TK_ENV_FILE="${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}"
TK_NAME="$(basename "${0:-lib}")"

tk_log() { # level(info|warning|err|crit) message...
  local lvl=$1
  shift
  logger -t "timekeeper-backup" -p "user.${lvl}" -- "${TK_NAME}: $*" 2>/dev/null || true
  printf '%s %s %s: %s\n' "$(date -u +%FT%TZ)" "$lvl" "$TK_NAME" "$*" >&2
}

tk_die() { # exit-code message...
  local code=$1
  shift
  tk_log err "$*"
  exit "$code"
}

tk_now() { echo "${TK_NOW:-$(date +%s)}"; }

tk_load_env() {
  if [ -r "$TK_ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$TK_ENV_FILE"
    set +a
  elif [ -n "${TK_BACKUP_ENV:-}" ]; then
    tk_die 10 "env file $TK_ENV_FILE is not readable / env файл уншигдахгүй байна"
  fi
  BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/timekeeper-backup}"
  BACKUP_SPOOL_DIR="${BACKUP_SPOOL_DIR:-$BACKUP_STATE_DIR/spool}"
  BACKUP_STAGING_DIR="${BACKUP_STAGING_DIR:-$BACKUP_STATE_DIR/staging}"
  BACKUP_SPOOL_WARN_MB="${BACKUP_SPOOL_WARN_MB:-256}"
  BACKUP_SPOOL_MAX_MB="${BACKUP_SPOOL_MAX_MB:-2048}" # 0 = spooling disabled
  BACKUP_PG_BIN="${BACKUP_PG_BIN:-/usr/lib/postgresql/16/bin}"
  BACKUP_WAL_SEG_MB="${BACKUP_WAL_SEG_MB:-16}"
  BACKUP_ARCHIVE_TIMEOUT_S="${BACKUP_ARCHIVE_TIMEOUT_S:-240}"
  BACKUP_WAL_MARGIN_S="${BACKUP_WAL_MARGIN_S:-120}"
  BACKUP_RPO_S="${BACKUP_RPO_S:-900}"
  BACKUP_MAX_BASE_AGE_H="${BACKUP_MAX_BASE_AGE_H:-26}"
  BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-7}"
  BACKUP_KEEP_WEEKLY="${BACKUP_KEEP_WEEKLY:-4}"
  BACKUP_KEEP_MONTHLY="${BACKUP_KEEP_MONTHLY:-3}"
  BACKUP_LOGICAL_KEEP="${BACKUP_LOGICAL_KEEP:-8}"
  BACKUP_RCLONE_FLAGS="${BACKUP_RCLONE_FLAGS:---retries 1 --low-level-retries 2 --contimeout 20s --timeout 120s}"
  BACKUP_ALERT_REPEAT_MIN="${BACKUP_ALERT_REPEAT_MIN:-60}"
  BACKUP_PROD_DATA_DIR="${BACKUP_PROD_DATA_DIR:-/var/lib/postgresql/16/main}"
  export BACKUP_STATE_DIR BACKUP_SPOOL_DIR
  [ -n "${RCLONE_CONFIG:-}" ] && export RCLONE_CONFIG
  return 0
}

tk_require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || tk_die 10 "required command '$c' not found / '$c' суулгаагүй"
  done
}

tk_require_remote() {
  [ -n "${BACKUP_REMOTE:-}" ] || tk_die 10 "BACKUP_REMOTE is not set / BACKUP_REMOTE тохируулаагүй"
  case "$BACKUP_REMOTE" in
    /*) : ;;
    *:*) tk_require_cmd rclone ;;
    *) tk_die 10 "BACKUP_REMOTE must be an absolute directory or an rclone remote (name:path)" ;;
  esac
}

tk_require_encrypt() {
  tk_require_remote
  tk_require_cmd age gzip sha256sum flock
  if [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
    [ -r "$BACKUP_AGE_RECIPIENTS_FILE" ] || tk_die 10 "BACKUP_AGE_RECIPIENTS_FILE not readable"
  else
    [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || tk_die 10 "BACKUP_AGE_RECIPIENT (age public key) is not set"
  fi
}

# --- encryption (age; public-key, so the server never holds a key that can decrypt) -----------
tk_age_encrypt() { # stdin -> stdout
  if [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
    age -R "$BACKUP_AGE_RECIPIENTS_FILE"
  else
    age -r "$BACKUP_AGE_RECIPIENT"
  fi
}
tk_age_decrypt() { age -d -i "$1"; } # identity file; stdin -> stdout

tk_sha256() { sha256sum "$1" | cut -d' ' -f1; }

tk_sync() { sync "$@" 2>/dev/null || true; } # fsync files / directories (coreutils >= 8.24)

# --- remote abstraction: plain directory (tests, NFS, sshfs) or rclone remote ---------------
# Paths are relative to BACKUP_REMOTE, e.g. wal/000000010000000000000003.gz.age
tk_rclone() {
  local -a flags
  read -r -a flags <<<"$BACKUP_RCLONE_FLAGS"
  rclone "${flags[@]}" "$@"
}

remote_put() { # local-file relpath   (atomic: temp name + rename for directories)
  local src=$1 rel=$2 dest tmp
  case "$BACKUP_REMOTE" in
    /*)
      dest="$BACKUP_REMOTE/$rel"
      mkdir -p "$(dirname "$dest")" || return 1
      tmp="$(dirname "$dest")/.tmp.$$.$(basename "$dest")"
      if cp -p -- "$src" "$tmp" && tk_sync "$tmp" && mv -f -- "$tmp" "$dest"; then
        tk_sync "$(dirname "$dest")"
      else
        rm -f -- "$tmp"
        return 1
      fi
      ;;
    *) tk_rclone copyto "$src" "$BACKUP_REMOTE/$rel" ;;
  esac
}

remote_get() { # relpath local-file
  local rel=$1 dst=$2
  case "$BACKUP_REMOTE" in
    /*) cp -- "$BACKUP_REMOTE/$rel" "$dst" ;;
    *) tk_rclone copyto "$BACKUP_REMOTE/$rel" "$dst" ;;
  esac
}

remote_exists() { # relpath ; 0 = exists, 1 = does not exist, 2 = cannot tell (remote unavailable)
  local rel=$1 out rc=0
  case "$BACKUP_REMOTE" in
    /*)
      [ -d "$BACKUP_REMOTE" ] || return 2
      [ -f "$BACKUP_REMOTE/$rel" ] && return 0
      return 1
      ;;
    *)
      # rclone exit codes: 3 = directory not found, 4 = file not found -> "does not exist";
      # anything else (network, auth, timeout) -> "cannot tell"
      out=$(tk_rclone lsf --files-only "$BACKUP_REMOTE/$rel" 2>/dev/null) || rc=$?
      case $rc in
        0) [ -n "$out" ] ;;
        3 | 4) return 1 ;;
        *) return 2 ;;
      esac
      ;;
  esac
}

remote_list() { # reldir ; prints "name<TAB>mtime-epoch<TAB>size"; empty if the dir does not exist
  local rel=$1 rc=0
  case "$BACKUP_REMOTE" in
    /*)
      [ -d "$BACKUP_REMOTE" ] || return 2
      [ -d "$BACKUP_REMOTE/$rel" ] || return 0
      find "$BACKUP_REMOTE/$rel" -maxdepth 1 -type f ! -name '.tmp.*' -printf '%f\t%T@\t%s\n' |
        awk -F'\t' '{split($2, a, "."); print $1 "\t" a[1] "\t" $3}'
      ;;
    *)
      tk_rclone lsjson --files-only "$BACKUP_REMOTE/$rel" 2>/dev/null |
        jq -r '.[] | [.Path, (.ModTime | sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdate), .Size] | @tsv' ||
        rc=$?
      return "$rc"
      ;;
  esac
}

remote_rm() { # relpath
  case "$BACKUP_REMOTE" in
    /*) rm -f -- "$BACKUP_REMOTE/$1" ;;
    *) tk_rclone deletefile "$BACKUP_REMOTE/$1" ;;
  esac
}

# --- WAL segment arithmetic (name = 8 hex timeline, 8 hex log, 8 hex segment) ----------------
tk_seg_per_log() { echo $((4294967296 / (BACKUP_WAL_SEG_MB * 1048576))); }
tk_seg_pos() { # name -> position number (timeline ignored)
  local n=$1
  echo $((16#${n:8:8} * $(tk_seg_per_log) + 16#${n:16:8}))
}
tk_seg_name() { # timeline(int) pos -> name
  local per
  per=$(tk_seg_per_log)
  printf '%08X%08X%08X' "$1" $(($2 / per)) $(($2 % per))
}

# --- alerting ---------------------------------------------------------------------------
tk_alert() { # severity message ; rate limited inside alert.sh
  local d
  d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  "$d/alert.sh" "$1" "$2" || true
}

# Extract a PostgreSQL tar-format base backup directory (base.tar.gz + pg_wal.tar.gz +
# backup_manifest) into a scratch directory and run pg_verifybackup on it.
tk_verify_pg_dir() { # dir-with-tar-files
  local src=$1 vd rc=0
  mkdir -p "$BACKUP_STAGING_DIR"
  vd=$(mktemp -d "$BACKUP_STAGING_DIR/verify.XXXXXX")
  {
    mkdir -p "$vd/pg/pg_wal" &&
      tar -xzf "$src/base.tar.gz" -C "$vd/pg" &&
      tar -xzf "$src/pg_wal.tar.gz" -C "$vd/pg/pg_wal" &&
      cp "$src/backup_manifest" "$vd/pg/backup_manifest" &&
      "$BACKUP_PG_BIN/pg_verifybackup" "$vd/pg" >&2
  } || rc=$?
  rm -rf "$vd"
  return "$rc"
}
