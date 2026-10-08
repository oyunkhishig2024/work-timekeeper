#!/usr/bin/env bash
# PostgreSQL only switches WAL segments on archive_timeout when there was WAL activity. A quiet
# night would therefore look like "archiving stopped". This writes one tiny non-transactional
# WAL record every few minutes (timer) so archive_timeout keeps producing a segment and the
# "newest archived WAL" age is a real signal. Run as the postgres user.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"
tk_load_env
"$BACKUP_PG_BIN/psql" -qAtX -v ON_ERROR_STOP=1 -d "${BACKUP_HEARTBEAT_DB:-postgres}" \
  -c "select pg_logical_emit_message(false, 'timekeeper', 'heartbeat')" >/dev/null ||
  tk_die 11 "heartbeat failed: database not reachable? / өгөгдлийн сан хүрэхгүй байна"
