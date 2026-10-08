#!/usr/bin/env bash
# PostgreSQL restore_command target:   wal-fetch.sh "%f" "%p"
# Fetches wal/<name>.gz.age from the remote, decrypts (age identity = BACKUP_AGE_IDENTITY),
# gunzips, checks the sha256 sidecar, atomically moves it into place.
#  exit 0   file delivered
#  exit 1   file is NOT in the archive (normal at the end of the archive)
#  exit 127 hard failure (remote unreachable, bad key, corrupt file). PostgreSQL treats 127 as
#           fatal and ABORTS recovery instead of silently ending it early and promoting.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

[ $# -eq 2 ] || exit 127
name=$1
dest=$2
tk_load_env
tk_require_remote
[ -n "${BACKUP_AGE_IDENTITY:-}" ] && [ -r "${BACKUP_AGE_IDENTITY}" ] || tk_die 127 "BACKUP_AGE_IDENTITY (private key file) not readable"

rc=0
remote_exists "wal/$name.gz.age" || rc=$?
[ "$rc" -eq 1 ] && exit 1
[ "$rc" -eq 0 ] || tk_die 127 "remote unavailable while fetching $name"

tmpd=$(mktemp -d "${dest}.tkfetch.XXXXXX") || exit 127
trap 'rm -rf -- "$tmpd"' EXIT
remote_get "wal/$name.gz.age" "$tmpd/enc" || tk_die 127 "download of $name failed"
tk_age_decrypt "$BACKUP_AGE_IDENTITY" <"$tmpd/enc" | gzip -dc >"$tmpd/plain" || tk_die 127 "decrypt/decompress of $name failed"
if remote_get "wal/$name.sha256" "$tmpd/sha" 2>/dev/null; then
  [ "$(tk_sha256 "$tmpd/plain")" = "$(cat "$tmpd/sha")" ] || tk_die 127 "checksum mismatch for $name"
fi
tk_sync "$tmpd/plain"
mv -f -- "$tmpd/plain" "$dest"
exit 0
