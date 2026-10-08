#!/usr/bin/env bash
# Weekly logical dump: second, version-independent layer (survives a major-version upgrade and
# lets you restore a single database or table without WAL replay).
#   pg_dump -Fc for each database in BACKUP_DUMP_DBS (space separated) + pg_dumpall --globals-only
#   (roles). Encrypted with age, uploaded to logical/, retention = newest BACKUP_LOGICAL_KEEP
#   (default 8) per kind. Run as the postgres user.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

tk_load_env
tk_require_encrypt
[ -n "${BACKUP_DUMP_DBS:-}" ] || tk_die 10 "BACKUP_DUMP_DBS is not set (e.g. \"timekeeper\")"
label=${TK_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}
umask 077
mkdir -p "$BACKUP_STAGING_DIR"
stage=$(mktemp -d "$BACKUP_STAGING_DIR/logical.XXXXXX")
trap 'rm -rf "$stage"' EXIT
fail() {
  tk_alert crit "logical dump $label FAILED: $* / логик нөөцлөлт амжилтгүй"
  tk_die 11 "$*"
}

upload() { # kind(file prefix) stagefile
  local f=$2
  tk_sync "$f"
  sha=$(tk_sha256 "$f")
  printf '%s  %s\n' "$sha" "$(basename "$f")" >"$f.sha256"
  remote_put "$f" "logical/$(basename "$f")" || fail "upload of $(basename "$f") failed"
  remote_put "$f.sha256" "logical/$(basename "$f").sha256" || fail "upload of checksum failed"
  rm -f "$f" "$f.sha256"
}

"$BACKUP_PG_BIN/pg_dumpall" --globals-only | tk_age_encrypt >"$stage/globals-$label.sql.age" || fail "pg_dumpall --globals-only failed"
upload globals "$stage/globals-$label.sql.age"
for db in $BACKUP_DUMP_DBS; do
  "$BACKUP_PG_BIN/pg_dump" -Fc -d "$db" | tk_age_encrypt >"$stage/dump-$db-$label.dump.age" || fail "pg_dump of $db failed"
  upload "$db" "$stage/dump-$db-$label.dump.age"
done
tk_log info "logical dump $label uploaded / логик нөөцлөлт хийгдлээ"

# retention: newest N per kind (labels sort chronologically)
prune() { # regex-prefix suffix
  local pre=$1 suf=$2 old
  while IFS= read -r old; do
    remote_rm "logical/$old"
    remote_rm "logical/$old.sha256"
  done < <(remote_list logical | cut -f1 | grep -E "^${pre}-[0-9]{8}T[0-9]{6}Z\\.${suf}\$" | sort -r | tail -n +$((BACKUP_LOGICAL_KEEP + 1)) || true)
}
prune globals 'sql\.age'
for db in $BACKUP_DUMP_DBS; do prune "dump-$db" 'dump\.age'; done
date +%s >"$BACKUP_STATE_DIR/last-logical-ok" 2>/dev/null || true
exit 0
