#!/usr/bin/env bash
# End-to-end PROOF of the backup / point-in-time-recovery solution, fully automated and
# self-contained. It builds a THROWAWAY PostgreSQL 16 cluster (initdb in a temp dir, port 5544),
# uses a temp directory as the "remote", and exercises: WAL archiving + encryption, base backups,
# disk loss, PITR to an exact moment, restore to the end of the archive, the safety refusals,
# spool/outage behaviour, retention with fake dates, the monitoring check, the logical dump.
# Nothing outside the temp dir is touched (the unrelated PostgreSQL on 5432 is never contacted).
#
# Usage:  infra/backup/test/pitr-rehearsal.sh        (as root or as any user that can run initdb)
#   KEEP=1   keep the temp dir for debugging      TMPDIR=/somewhere   change the temp parent
# Exit code 0 only if every assertion passed. Takes about 2-4 minutes.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT=5544
MARK='TK-SECRET-MARKER-7c1d9e-Бат-Эрдэнэ'
export PATH="$PGBIN:$PATH"

for c in initdb pg_ctl psql age age-keygen jq; do
  command -v "$c" >/dev/null || {
    echo "missing tool: $c" >&2
    exit 2
  }
done

W=$(mktemp -d "${TMPDIR:-/tmp}/tk-pitr.XXXXXX")
chmod 755 "$W"
if [ "$(id -u)" -eq 0 ]; then
  PGOS=postgres
  as_pg() { (cd / && runuser -u "$PGOS" -- "$@"); }
else
  PGOS=$(id -un)
  as_pg() { (cd / && "$@"); }
fi
own() { [ "$(id -u)" -ne 0 ] || chown -R "$PGOS" "$@"; }

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  echo "  PASS  $1"
}
bad() {
  FAIL=$((FAIL + 1))
  echo "  FAIL  $1" >&2
}
eq() { # description expected actual
  if [ "$2" = "$3" ]; then ok "$1 (= $3)"; else bad "$1: expected '$2' got '$3'"; fi
}
yes() { # description command...
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
no() {
  local d=$1
  shift
  if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi
}
section() { printf '\n== %s\n' "$*"; }

cleanup() {
  local rc=$?
  set +e
  for d in "$W"/pgdata "$W"/r[0-9]*; do
    [ -f "$d/postmaster.pid" ] && as_pg pg_ctl -D "$d" -m immediate -w stop >/dev/null 2>&1
  done
  if [ "${KEEP:-0}" = "1" ]; then echo "KEEP=1: leaving $W"; else rm -rf "$W"; fi
  exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------
section "setup: scripts installed root-owned, age key pair, env file, throwaway cluster on port $PORT"
mkdir -p "$W"/{opt,keys,sock,remote,state,fake,etc-conf}
cp -r "$SRC"/. "$W/opt/"
chmod -R go+rX "$W/opt"
echo "# fake server config" >"$W/etc-conf/postgresql.conf"
age-keygen -o "$W/keys/id.txt" >/dev/null 2>&1
chmod 644 "$W/keys/id.txt"
RECIP=$(age-keygen -y "$W/keys/id.txt")
own "$W/remote" "$W/state" "$W/sock" "$W/fake"

mkenv() { # file remote state [extra lines...]
  local f=$1 r=$2 s=$3
  shift 3
  mkdir -p "$s"
  own "$s"
  {
    echo "BACKUP_REMOTE=$r"
    echo "BACKUP_AGE_RECIPIENT=$RECIP"
    echo "BACKUP_AGE_IDENTITY=$W/keys/id.txt"
    echo "BACKUP_STATE_DIR=$s"
    echo "BACKUP_PG_BIN=$PGBIN"
    echo "BACKUP_DUMP_DBS=tkdemo"
    echo "BACKUP_ARCHIVE_TIMEOUT_S=5"
    echo "BACKUP_WAL_MARGIN_S=60"
    echo "BACKUP_PG_CONF_DIR=$W/etc-conf"
    echo "BACKUP_PROD_DATA_DIR=$W/not-the-real-prod-dir"
    echo "PGHOST=$W/sock"
    echo "PGPORT=$PORT"
    echo "PGUSER=postgres"
    for l in "$@"; do echo "$l"; done
  } >"$f"
  chmod 644 "$f"
}
mkenv "$W/backup.env" "$W/remote" "$W/state"
export PGHOST="$W/sock" PGPORT=$PORT PGUSER=postgres

B="$W/opt/bin"
run() { # envfile script args...   (as the postgres OS user, like systemd would)
  local e=$1 s=$2
  shift 2
  as_pg env TK_BACKUP_ENV="$e" "$B/$s" "$@"
}
rc_of() { # prints the exit code of a command, never fails
  local r=0
  "$@" >/dev/null 2>&1 || r=$?
  echo "$r"
}

PGDATA="$W/pgdata"
mkdir -p "$PGDATA"
own "$PGDATA"
as_pg initdb -D "$PGDATA" -U postgres -A trust --data-checksums >/dev/null
cat >>"$PGDATA/postgresql.conf" <<EOF
port = $PORT
unix_socket_directories = '$W/sock'
listen_addresses = ''
include '$W/opt/postgresql-backup.conf'
archive_command = 'TK_BACKUP_ENV=$W/backup.env $W/opt/bin/wal-archive.sh "%p" "%f"'
archive_timeout = 5
EOF
as_pg pg_ctl -D "$PGDATA" -l "$W/sock/pg.log" -w start >/dev/null
eq "cluster is PostgreSQL 16" "16" "$(psql -Atc "show server_version_num" postgres | cut -c1-2)"
eq "archive_mode is on (from postgresql-backup.conf)" "on" "$(psql -Atc 'show archive_mode' postgres)"
eq "wal_level is replica" "replica" "$(psql -Atc 'show wal_level' postgres)"
eq "data checksums on" "on" "$(psql -Atc 'show data_checksums' postgres)"
yes "wal_compression is enabled" test "$(psql -Atc 'show wal_compression' postgres)" != "off"
ARCH_TIMEOUT_SETTING=$(grep -E '^archive_timeout' "$SRC/postgresql-backup.conf" | grep -oE '[0-9]+' | sed -n 1p)
yes "shipped archive_timeout ($ARCH_TIMEOUT_SETTING s) keeps RPO well under 900 s" test "$ARCH_TIMEOUT_SETTING" -le 300

q() { psql -d tkdemo -Atc "$1"; }
psql -qc "create database tkdemo" postgres
q "create table events(id bigserial primary key, batch text not null, payload text not null);
   create table accidental(id int primary key, note text);
   insert into accidental select g, 'keep me '||g from generate_series(1,50) g;
   insert into events(batch,payload) select 'b0', '$MARK '||md5(g::text)||repeat('x',200) from generate_series(1,2000) g;" >/dev/null
batch() { q "insert into events(batch,payload) select '$1', '$MARK '||g from generate_series(1,$2) g" >/dev/null; }
count() { q "select count(*) from events"; }
stamp() { psql -Atc "select clock_timestamp()::text" postgres; }
wait_archived() { # switch the WAL and wait until the archiver (and spool) has shipped it
  local seg
  seg=$(psql -Atc "select pg_walfile_name(pg_switch_wal() - 1)" postgres)
  for _ in $(seq 1 90); do
    [ "$(psql -Atc 'select last_archived_wal from pg_stat_archiver' postgres)" \> "$seg" ] ||
      [ "$(psql -Atc 'select last_archived_wal from pg_stat_archiver' postgres)" = "$seg" ] && break
    sleep 1
  done
  for _ in $(seq 1 30); do
    [ -z "$(find "$W/state/spool" -maxdepth 1 -name '*.gz.age' 2>/dev/null | sed -n 1p)" ] && return 0
    sleep 1
  done
  return 1
}
psql -qAtc "checkpoint" postgres >/dev/null
yes "plaintext control: the marker IS in the live data files" grep -rqF "$MARK" "$PGDATA/base"

# ---------------------------------------------------------------------------------------------
section "WAL archiving: archive_command, archive_timeout and heartbeat on a quiet database"
before=$(psql -Atc 'select last_archived_wal from pg_stat_archiver' postgres)
yes "wal-heartbeat.sh runs" run "$W/backup.env" wal-heartbeat.sh
changed=0
for _ in $(seq 1 25); do
  now=$(psql -Atc 'select last_archived_wal from pg_stat_archiver' postgres)
  if [ -n "$now" ] && [ "$now" != "$before" ]; then
    changed=1
    break
  fi
  sleep 1
done
eq "an idle database still archives a segment within archive_timeout (+ heartbeat)" "1" "$changed"
eq "archiver reports no failures so far" "0" "$(psql -Atc 'select failed_count from pg_stat_archiver' postgres)"

# ---------------------------------------------------------------------------------------------
section "base backup #1 (before the test batches)"
run "$W/backup.env" base-backup.sh --no-retention >"$W/base1.log" 2>&1 || {
  cat "$W/base1.log"
  bad "base backup #1 failed"
}
BASE1=$(ls "$W/remote/base" | grep -E '^base-.*\.json$' | sed -n 1p | sed 's/^base-//; s/\.json$//')
yes "base backup #1 catalog exists ($BASE1)" test -f "$W/remote/base/base-$BASE1.json"
eq "catalog says verified" "true" "$(jq -r .verified "$W/remote/base/base-$BASE1.json")"
yes "catalog has wal_start_segment" jq -e '.wal_start_segment|test("^[0-9A-F]{24}$")' "$W/remote/base/base-$BASE1.json"
eq "staging directory cleaned up" "0" "$(find "$W/state/staging" -mindepth 1 2>/dev/null | wc -l)"
sleep 2

# ---------------------------------------------------------------------------------------------
section "workload: batches with exact timestamps, forced WAL switches"
batch b1 500
C1=$(count)
T1=$(stamp)
sleep 1
batch b2 700
C2=$(count)
T2=$(stamp)
sleep 1
wait_archived || bad "spool did not drain"
batch b3 900
C3=$(count)
T3=$(stamp)
sleep 1
echo "  counts: after b1=$C1 (T1=$T1)  after b2=$C2 (T2=$T2)  after b3=$C3 (T3=$T3)"

section "base backup #2 (between batch 3 and 4) and the retention-free chain"
sleep 1
run "$W/backup.env" base-backup.sh --no-retention >"$W/base2.log" 2>&1 || {
  cat "$W/base2.log"
  bad "base backup #2 failed"
}
BASE2=$(ls "$W/remote/base" | grep -E '^base-.*\.json$' | tail -1 | sed 's/^base-//; s/\.json$//')
if [ "$BASE1" != "$BASE2" ]; then ok "two distinct base backups ($BASE1, $BASE2)"; else bad "base labels equal"; fi
sleep 1
batch b4 300
wait_archived || bad "spool did not drain"
C4=$(count)
T4=$(stamp)
sleep 1
q "drop table accidental" >/dev/null # the "logical mistake"
batch b5 100
wait_archived || bad "spool did not drain"
batch b5 1
wait_archived || bad "spool did not drain"
batch b5 1
wait_archived || bad "spool did not drain"
CL=$(count)
echo "  after b4=$C4 (T4=$T4, then DROP TABLE accidental)  final=$CL"
eq "archiver still reports no failures" "0" "$(psql -Atc 'select failed_count from pg_stat_archiver' postgres)"

# ---------------------------------------------------------------------------------------------
section "encryption: nothing readable leaves the server"
nfiles=$(find "$W/remote" -type f | wc -l)
echo "  remote now holds $nfiles files"
bad_hdr=0
for f in "$W"/remote/wal/*.gz.age "$W"/remote/base/*.tar.age; do
  [ "$(head -c 21 "$f")" = "age-encryption.org/v1" ] || bad_hdr=$((bad_hdr + 1))
done
eq "every WAL and base file starts with the age header" "0" "$bad_hdr"
no "plaintext marker appears in NO remote file" grep -rqF "$MARK" "$W/remote"
no "marker is not in the local spool either" grep -rqF "$MARK" "$W/state"
yes "WAL file can be decrypted with the offline key and has the WAL magic" bash -c \
  "f=\$(ls $W/remote/wal/*.gz.age | sed -n 1p); age -d -i $W/keys/id.txt < \$f | gzip -dc | head -c 2 | od -An -tx1 | grep -qE '[0-9a-f]{2} [0-9a-f]{2}'"
no "the public key alone cannot decrypt (wrong identity fails)" bash -c \
  "age-keygen -o $W/keys/other.txt >/dev/null 2>&1; f=\$(ls $W/remote/wal/*.gz.age | sed -n 1p); age -d -i $W/keys/other.txt < \$f"

# ---------------------------------------------------------------------------------------------
section "monitoring: verify-backups.sh (healthy system, then four broken ones)"
vjson() { # envfile [args] -> stores JSON in $W/v.json, echoes exit code
  local r=0
  run "$1" verify-backups.sh "${@:2}" >"$W/v.json" 2>"$W/v.err" || r=$?
  echo "$r"
}
psql -qAtc "select pg_logical_emit_message(false,'t','x')" postgres >/dev/null
wait_archived || true
r=$(vjson "$W/backup.env")
cat "$W/v.json"
eq "healthy: exit code 0" "0" "$r"
eq "healthy: status OK" "OK" "$(jq -r .status "$W/v.json")"
eq "healthy: one line of JSON" "1" "$(wc -l <"$W/v.json")"
r=$(vjson "$W/backup.env" --deep)
eq "deep verify exit 0" "0" "$r"
yes "deep verify ran pg_verifybackup on the decrypted base" bash -c "jq -r .checks.deep.detail $W/v.json | grep -q 'pg_verifybackup passed'"

# gap AFTER the newest base -> CRIT ; gap only BEFORE it -> WARN
POS2=$(jq -r .wal_start_segment "$W/remote/base/base-$BASE2.json")
mapfile -t segs < <(ls "$W/remote/wal" | grep -E '^[0-9A-F]{24}\.gz\.age$' | sed 's/\.gz\.age//' | sort)
older=() newer=()
for s in "${segs[@]}"; do
  if [[ $s < $POS2 ]]; then older+=("$s"); else newer+=("$s"); fi
done
echo "  segments: ${#segs[@]} total, ${#older[@]} before base #2 start ($POS2), ${#newer[@]} from it"
cp -a "$W/remote" "$W/remote_gap"
rm -f "$W/remote_gap/wal/${newer[1]}.gz.age" "$W/remote_gap/wal/${newer[1]}.sha256"
mkenv "$W/gap.env" "$W/remote_gap" "$W/state"
r=$(vjson "$W/gap.env")
eq "missing WAL segment after the newest base: exit 2" "2" "$r"
eq "  wal_gaps = CRIT" "CRIT" "$(jq -r .checks.wal_gaps.status "$W/v.json")"
cp -a "$W/remote" "$W/remote_gap2"
if [ "${#older[@]}" -ge 2 ]; then
  rm -f "$W/remote_gap2/wal/${older[1]}.gz.age" "$W/remote_gap2/wal/${older[1]}.sha256"
  mkenv "$W/gap2.env" "$W/remote_gap2" "$W/state"
  r=$(vjson "$W/gap2.env")
  eq "missing WAL segment only before the newest base: exit 1" "1" "$r"
  eq "  wal_gaps = WARN" "WARN" "$(jq -r .checks.wal_gaps.status "$W/v.json")"
else
  ok "(skipped older-gap case: only ${#older[@]} older segments)"
fi

NOW=$(date +%s)
r=$(TK_NOW=$((NOW + 30 * 3600)) vjson "$W/backup.env")
eq "newest base 30 h old: exit 2" "2" "$r"
eq "  base_age = CRIT" "CRIT" "$(jq -r .checks.base_age.status "$W/v.json")"
r=$(TK_NOW=$((NOW + 20 * 60)) vjson "$W/backup.env")
eq "no new WAL for 20 min (> RPO): exit 2" "2" "$r"
eq "  wal_age = CRIT" "CRIT" "$(jq -r .checks.wal_age.status "$W/v.json")"
r=$(TK_NOW=$((NOW + 100)) vjson "$W/backup.env")
eq "no new WAL for 100 s (> 2 x 5 s + 60 s): exit 1" "1" "$r"
eq "  wal_age = WARN" "WARN" "$(jq -r .checks.wal_age.status "$W/v.json")"

cp -a "$W/remote" "$W/remote_bad"
newest_base=$(ls "$W/remote_bad/base" | grep '\.tar\.age$' | tail -1)
printf '\377' | dd of="$W/remote_bad/base/$newest_base" bs=1 seek=300 conv=notrunc 2>/dev/null
mkenv "$W/bad.env" "$W/remote_bad" "$W/state"
r=$(vjson "$W/bad.env" --deep)
eq "corrupted base backup found by --deep: exit 2" "2" "$r"
yes "  deep detail mentions the checksum" bash -c "jq -r .checks.deep.detail $W/v.json | grep -q 'sha256'"
rm -f "$W/state/deep-verify.json"

cp -a "$W/remote" "$W/remote_plain"
newest_wal=$(ls -t "$W/remote_plain/wal" | grep '\.gz\.age$' | sed -n 1p)
echo "this is NOT encrypted" >"$W/remote_plain/wal/$newest_wal"
mkenv "$W/plain.env" "$W/remote_plain" "$W/state"
r=$(vjson "$W/plain.env")
eq "unencrypted newest WAL file: exit 2" "2" "$r"
eq "  newest_file = CRIT" "CRIT" "$(jq -r .checks.newest_file.status "$W/v.json")"

mkenv "$W/spool.env" "$W/remote" "$W/state_spool" "BACKUP_SPOOL_WARN_MB=1"
mkdir -p "$W/state_spool/spool"
head -c 3000000 /dev/zero >"$W/state_spool/spool/junk.bin"
own "$W/state_spool"
r=$(vjson "$W/spool.env")
eq "spool above the warning size: exit 1" "1" "$r"
eq "  spool = WARN" "WARN" "$(jq -r .checks.spool.status "$W/v.json")"
mkenv "$W/unreach.env" "$W/does-not-exist" "$W/state"
r=$(vjson "$W/unreach.env")
eq "remote unreachable: exit 2" "2" "$r"

# ---------------------------------------------------------------------------------------------
section "logical dump (second layer) and its retention of the newest N"
mkenv "$W/logical.env" "$W/remote_logical" "$W/state" "BACKUP_LOGICAL_KEEP=2"
mkdir -p "$W/remote_logical"
own "$W/remote_logical"
for lab in 20261001T010000Z 20261002T010000Z 20261003T010000Z; do
  TK_LABEL=$lab run "$W/logical.env" logical-dump.sh >/dev/null 2>&1 || bad "logical dump $lab failed"
done
eq "only the newest 2 database dumps are kept" "2" "$(ls "$W/remote_logical/logical" | grep -c '^dump-tkdemo-.*\.dump\.age$')"
eq "only the newest 2 globals dumps are kept" "2" "$(ls "$W/remote_logical/logical" | grep -c '^globals-.*\.sql\.age$')"
yes "oldest dump (20261001) was the one removed" test ! -e "$W/remote_logical/logical/dump-tkdemo-20261001T010000Z.dump.age"
age -d -i "$W/keys/id.txt" <"$W/remote_logical/logical/dump-tkdemo-20261003T010000Z.dump.age" >"$W/dump.custom"
yes "decrypted dump is a valid pg_dump -Fc archive containing table events" bash -c "pg_restore -l $W/dump.custom | grep -q 'TABLE public events'"
no "marker not visible in the encrypted dump" grep -rqF "$MARK" "$W/remote_logical"

# ---------------------------------------------------------------------------------------------
section "wal-archive.sh edge cases (fake WAL file, own remote and spool)"
WALN=000000010000000000000042
head -c 3000000 /dev/urandom >"$W/fake/$WALN"
own "$W/fake"
mkdir -p "$W/remote2"
own "$W/remote2"
mkenv "$W/e2.env" "$W/remote2" "$W/state2" "BACKUP_SPOOL_MAX_MB=100"
own "$W"/opt 2>/dev/null || true
chmod -R go+rX "$W/opt"
arch() { run "$1" wal-archive.sh "$2" "$3"; }
r=$(rc_of arch "$W/e2.env" "$W/fake/$WALN" "$WALN")
eq "archive a segment: exit 0" "0" "$r"
yes "  .gz.age and .sha256 are in the remote" test -f "$W/remote2/wal/$WALN.gz.age" -a -f "$W/remote2/wal/$WALN.sha256"
eq "  decrypt+gunzip gives back the exact segment" "$(sha256sum <"$W/fake/$WALN" | cut -d' ' -f1)" "$(age -d -i "$W/keys/id.txt" <"$W/remote2/wal/$WALN.gz.age" | gzip -dc | sha256sum | cut -d' ' -f1)"
eq "  spool is empty after the upload" "0" "$(find "$W/state2/spool" -maxdepth 1 -name '*.gz.age' | wc -l)"
h1=$(sha256sum <"$W/remote2/wal/$WALN.gz.age")
r=$(rc_of arch "$W/e2.env" "$W/fake/$WALN" "$WALN")
eq "archive the same segment again (PostgreSQL retry): exit 0" "0" "$r"
eq "  remote file untouched" "$h1" "$(sha256sum <"$W/remote2/wal/$WALN.gz.age")"
cp "$W/fake/$WALN" "$W/fake/${WALN}.orig"
head -c 3000000 /dev/urandom >"$W/fake/$WALN.other"
own "$W/fake"
r=$(rc_of arch "$W/e2.env" "$W/fake/$WALN.other" "$WALN")
eq "same name, DIFFERENT content: exit 12 (never overwritten)" "12" "$r"
eq "  remote file still the original" "$h1" "$(sha256sum <"$W/remote2/wal/$WALN.gz.age")"
yes "  the rejected copy is parked in spool/conflict" test -n "$(ls "$W/state2/spool/conflict")"
r=$(vjson "$W/e2.env")
eq "  verify-backups reports the parked conflict as CRIT" "CRIT" "$(jq -r .checks.spool.status "$W/v.json")"
rm -rf "$W/state2/spool/conflict"/*

# remote outage: spool, then drain
chmod a-w "$W/remote2/wal"
W2=000000010000000000000043
W3=000000010000000000000044
head -c 2000000 /dev/urandom >"$W/fake/$W2"
head -c 2000000 /dev/urandom >"$W/fake/$W3"
own "$W/fake"
r=$(rc_of arch "$W/e2.env" "$W/fake/$W2" "$W2")
eq "remote UNWRITABLE, spool enabled: exit 0 (queued, WAL archiving not blocked)" "0" "$r"
yes "  the segment waits in the spool" test -f "$W/state2/spool/$W2.gz.age"
no "  and is not in the remote yet" test -e "$W/remote2/wal/$W2.gz.age"
chmod u+w "$W/remote2/wal"
chmod go+w "$W/remote2/wal"
r=$(rc_of arch "$W/e2.env" "$W/fake/$W3" "$W3")
eq "remote back: next call exit 0" "0" "$r"
yes "  queued segment was uploaded by the next call" test -f "$W/remote2/wal/$W2.gz.age"
yes "  new segment uploaded too" test -f "$W/remote2/wal/$W3.gz.age"
eq "  spool drained" "0" "$(find "$W/state2/spool" -maxdepth 1 -name '*.gz.age' | wc -l)"

W4=000000010000000000000045
head -c 100000 /dev/urandom >"$W/fake/$W4"
own "$W/fake"
mkenv "$W/e3.env" "$W/remote2" "$W/state3" "BACKUP_SPOOL_MAX_MB=0"
chmod a-w "$W/remote2/wal"
r=$(rc_of arch "$W/e3.env" "$W/fake/$W4" "$W4")
eq "remote UNWRITABLE, spooling disabled: exit 14 (non-zero, PostgreSQL retries)" "14" "$r"
chmod go+w "$W/remote2/wal"
chmod u+w "$W/remote2/wal"
mkenv "$W/e4.env" "$W/remote2" "$W/state4" "BACKUP_SPOOL_MAX_MB=1"
mkdir -p "$W/state4/spool"
head -c 2500000 /dev/zero >"$W/state4/spool/junk.bin"
own "$W/state4"
r=$(rc_of arch "$W/e4.env" "$W/fake/$W4" "$W4")
eq "spool full (limit reached): exit 13" "13" "$r"
mkenv "$W/e5.env" "$W/remote2" "$W/state5"
sed -i '/BACKUP_AGE_RECIPIENT=/d' "$W/e5.env"
r=$(rc_of arch "$W/e5.env" "$W/fake/$W4" "$W4")
eq "no encryption key configured: exit 10 (refuses to ship plaintext)" "10" "$r"
no "  nothing was written to the remote" test -e "$W/remote2/wal/$W4.gz.age"

section "wal-fetch.sh (restore_command) exit codes"
fetch() { as_pg env TK_BACKUP_ENV="$1" "$B/wal-fetch.sh" "$2" "$3"; }
r=$(rc_of fetch "$W/e2.env" "$WALN" "$W/fake/out.fetched")
eq "existing segment: exit 0" "0" "$r"
yes "  content identical to the original" cmp -s "$W/fake/out.fetched" "$W/fake/$WALN.orig"
r=$(rc_of fetch "$W/e2.env" 000000010000000000000099 "$W/fake/out.none")
eq "segment not in the archive: exit 1 (normal end of archive)" "1" "$r"
r=$(rc_of fetch "$W/unreach.env" "$WALN" "$W/fake/out.x")
eq "remote unreachable: exit 127 (aborts recovery instead of ending it early)" "127" "$r"

# ---------------------------------------------------------------------------------------------
section "retention: 100 daily fake base backups (2026-07-01 .. 2026-10-08) and a WAL chain"
RR="$W/remote_ret"
mkdir -p "$RR/base" "$RR/wal"
mkenv "$W/ret.env" "$RR" "$W/state_ret"
mkdir -p "$W/state_ret"
mkcat() { # remote label wal-pos verified
  local r=$1 l=$2 p=$3 v=$4
  jq -cn --arg l "$l" --arg s "$(printf '%08X%08X%08X' 1 $((p / 256)) $((p % 256)))" --argjson v "$v" \
    '{schema:1,label:$l,wal_start_segment:$s,verified:$v,finished_epoch:0}' >"$r/base/base-$l.json"
  echo x >"$r/base/base-$l.tar.age"
}
mkwal() { # remote pos
  local n
  n=$(printf '%08X%08X%08X' 1 $(($2 / 256)) $(($2 % 256)))
  echo x >"$1/wal/$n.gz.age"
  echo x >"$1/wal/$n.sha256"
}
for k in $(seq 0 99); do
  d=$(date -u -d "2026-07-01 + $k days" +%Y%m%d)
  mkcat "$RR" "${d}T183000Z" $((100 + k * 10)) true
done
for p in $(seq 100 1095); do mkwal "$RR" "$p"; done
echo x >"$RR/wal/00000002.history.gz.age"
own "$RR"
run "$W/ret.env" retention.sh --dry-run >"$W/ret.out"
eq "dry run deletes nothing (base files)" "100" "$(ls "$RR/base" | grep -c '\.json$')"
run "$W/ret.env" retention.sh >"$W/ret.out" 2>&1 || cat "$W/ret.out"
echo "  $(tail -1 "$W/ret.out" | cut -c1-300)"
expect="20261008 20261007 20261006 20261005 20261004 20261003 20261002 20260927 20260920 20260930 20260831"
got=$(ls "$RR/base" | grep '\.json$' | sed 's/^base-//; s/T183000Z\.json$//' | sort | tr '\n' ' ')
# shellcheck disable=SC2086
exp=$(printf '%s\n' $expect | sort | tr '\n' ' ')
eq "kept = 7 daily + weekly (Sun 09-27, 09-20) + monthly (09-30, 08-31)" "$exp" "$got"
eq "each kept base still has its data file" "11" "$(ls "$RR/base" | grep -c '\.tar\.age$')"
eq "oldest retained base is 2026-08-31 (WAL start position 710)" "20260831" "$(ls "$RR/base" | grep '\.json$' | sed -n 1p | sed 's/^base-//; s/T.*//')"
minwal=$(ls "$RR/wal" | grep -E '^[0-9A-F]{24}\.gz\.age$' | sed -n 1p)
eq "oldest WAL kept = start segment of the oldest retained base" "$(printf '%08X%08X%08X' 1 2 $((710 % 256)))" "${minwal%.gz.age}"
eq "WAL segments kept: positions 710..1095" "386" "$(ls "$RR/wal" | grep -cE '^[0-9A-F]{24}\.gz\.age$')"
eq "WAL checksum sidecars deleted together with segments" "386" "$(ls "$RR/wal" | grep -cE '^[0-9A-F]{24}\.sha256$')"
yes "timeline history file kept" test -f "$RR/wal/00000002.history.gz.age"

mkdir -p "$W/remote_ret2/base" "$W/remote_ret2/wal"
mkcat "$W/remote_ret2" 20260901T010000Z 100 true
mkcat "$W/remote_ret2" 20261007T010000Z 500 false
for p in 50 100 300 600; do mkwal "$W/remote_ret2" "$p"; done
own "$W/remote_ret2"
mkenv "$W/ret2.env" "$W/remote_ret2" "$W/state_ret"
run "$W/ret2.env" retention.sh >/dev/null 2>&1
yes "newest VERIFIED base is never deleted (even when a newer unverified one exists)" test -f "$W/remote_ret2/base/base-20260901T010000Z.tar.age"
yes "the newer unverified base is not touched either" test -f "$W/remote_ret2/base/base-20261007T010000Z.tar.age"
eq "WAL before the oldest retained base removed, rest kept" "3" "$(ls "$W/remote_ret2/wal" | grep -c '\.gz\.age$')"
mkdir -p "$W/remote_ret3/base" "$W/remote_ret3/wal"
mkcat "$W/remote_ret3" 20260901T010000Z 100 false
for p in 50 100; do mkwal "$W/remote_ret3" "$p"; done
own "$W/remote_ret3"
mkenv "$W/ret3.env" "$W/remote_ret3" "$W/state_ret"
run "$W/ret3.env" retention.sh >/dev/null 2>&1
eq "no verified base at all: nothing deleted" "2" "$(ls "$W/remote_ret3/wal" | grep -c '\.gz\.age$')"
echo '{broken' >"$W/remote_ret3/base/base-20260902T010000Z.json"
mkcat "$W/remote_ret3" 20260903T010000Z 200 true
own "$W/remote_ret3"
run "$W/ret3.env" retention.sh >/dev/null 2>&1
eq "unreadable catalog: WAL deletion is skipped (fail safe)" "2" "$(ls "$W/remote_ret3/wal" | grep -c '\.gz\.age$')"

# ---------------------------------------------------------------------------------------------
section "rclone code path (interface check with a stand-in rclone, NOT the real rclone)"
mkdir -p "$W/shim" "$W/fakeremote"
cat >"$W/shim/rclone" <<'SHIM'
#!/usr/bin/env bash
args=()
while [ $# -gt 0 ]; do
  case $1 in
    --retries | --low-level-retries | --contimeout | --timeout) shift 2 ;;
    --*) shift ;;
    *) args+=("$1"); shift ;;
  esac
done
map() { echo "$FAKE_ROOT/${1#fake:}"; }
case ${args[0]} in
  copyto)
    s=${args[1]}; d=${args[2]}
    [[ $s == fake:* ]] && s=$(map "$s")
    [[ $d == fake:* ]] && d=$(map "$d")
    [ -e "$s" ] || exit 4
    mkdir -p "$(dirname "$d")"; cp -p "$s" "$d" ;;
  lsf)
    p=$(map "${args[1]}")
    if [ -f "$p" ]; then basename "$p"; elif [ -d "$p" ]; then ls -1 "$p"; else exit 3; fi ;;
  lsjson)
    p=$(map "${args[1]}"); [ -d "$p" ] || exit 3
    find "$p" -maxdepth 1 -type f -printf '%f\t%T@\t%s\n' | awk -F'\t' '{split($2,a,"."); print $1"\t"a[1]"\t"$3}' |
      while IFS=$'\t' read -r n t s; do jq -cn --arg n "$n" --arg t "$(date -u -d @"$t" +%FT%T.000000000Z)" --argjson s "$s" '{Path:$n,Size:$s,ModTime:$t}'; done | jq -s . ;;
  deletefile) rm -f "$(map "${args[1]}")" ;;
  *) exit 1 ;;
esac
SHIM
chmod 755 "$W/shim/rclone"
chmod 755 "$W/shim"
mkdir -p "$W/fakeremote/bucket/tk"
cp -a "$W/remote/base" "$W/remote/wal" "$W/fakeremote/bucket/tk/"
own "$W/fakeremote"
mkenv "$W/rc.env" "fake:bucket/tk" "$W/state_rc" "BACKUP_SPOOL_MAX_MB=100"
newest=$(ls "$W/remote/wal" | grep -E '^[0-9A-F]{24}\.gz\.age$' | sort | tail -1)
RCN=$(printf '%024X' $((16#${newest%.gz.age} + 1))) # the next segment in sequence, so the chain stays gap free
r=$(PATH="$W/shim:$PATH" FAKE_ROOT="$W/fakeremote" rc_of arch "$W/rc.env" "$W/fake/$WALN" "$RCN")
eq "rclone path: archive a new segment: exit 0" "0" "$r"
yes "  it arrived as .gz.age + .sha256 under the bucket prefix" test -f "$W/fakeremote/bucket/tk/wal/$RCN.gz.age" -a -f "$W/fakeremote/bucket/tk/wal/$RCN.sha256"
r=$(PATH="$W/shim:$PATH" FAKE_ROOT="$W/fakeremote" rc_of arch "$W/rc.env" "$W/fake/$WALN" "$RCN")
eq "rclone path: identical retry: exit 0" "0" "$r"
r=$(PATH="$W/shim:$PATH" FAKE_ROOT="$W/fakeremote" rc_of arch "$W/rc.env" "$W/fake/$WALN.other" "$RCN")
eq "rclone path: different content, same name: exit 12" "12" "$r"
r=$(PATH="$W/shim:$PATH" FAKE_ROOT="$W/fakeremote" bash -c "TK_BACKUP_ENV=$W/rc.env BACKUP_CHECK_LOCAL_PG=0 $B/verify-backups.sh >$W/v.json 2>/dev/null; echo \$?")
eq "rclone path: listing/catalog/gap logic works (base_age)" "OK" "$(jq -r .checks.base_age.status "$W/v.json")"
eq "rclone path: wal_gaps" "OK" "$(jq -r .checks.wal_gaps.status "$W/v.json")"

# ---------------------------------------------------------------------------------------------
section "DISASTER: the data directory is destroyed (simulated disk loss)"
as_pg pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null
rm -rf "$PGDATA"
no "data directory is gone" test -e "$PGDATA"
REMOTE_FILES_BEFORE=$(find "$W/remote" -type f | wc -l)

# ---------------------------------------------------------------------------------------------
section "restore safety refusals (they must act BEFORE touching anything)"
RP() { TK_BACKUP_ENV="$W/backup.env" "$B/restore-pitr.sh" "$@"; }
mkdir -p "$W/r_ne"
echo precious >"$W/r_ne/file"
r=$(rc_of RP --latest --data-dir "$W/r_ne" --port 5546 --socket-dir "$W/sock")
eq "non-empty data dir without --force: refused (exit 10)" "10" "$r"
eq "  and its content is untouched" "precious" "$(cat "$W/r_ne/file")"
r=$(rc_of RP --latest --data-dir "$W/r_x" --port 5432)
eq "port 5432 without --i-am-sure: refused (exit 10)" "10" "$r"
no "  nothing was created" test -e "$W/r_x"
sed -i "s#^BACKUP_PROD_DATA_DIR=.*#BACKUP_PROD_DATA_DIR=$W/r_prod#" "$W/backup.env"
r=$(rc_of RP --latest --data-dir "$W/r_prod" --port 5546)
eq "production data dir without --i-am-sure: refused (exit 10)" "10" "$r"
sed -i "s#^BACKUP_PROD_DATA_DIR=.*#BACKUP_PROD_DATA_DIR=$W/not-the-real-prod-dir#" "$W/backup.env"
r=$(rc_of RP --data-dir "$W/r_x" --port 5546)
eq "neither --target-time nor --latest: usage error (exit 10)" "10" "$r"
r=$(rc_of RP --target-time "garbage" --data-dir "$W/r_x" --port 5546)
eq "unparsable target time: exit 10" "10" "$r"

# ---------------------------------------------------------------------------------------------
section "RESTORE 1: point in time T2 (between batch 2 and 3), base chosen automatically"
t0=$(date +%s.%N)
RP --target-time "$T2" --data-dir "$W/r1" --port 5545 --socket-dir "$W/sock" >"$W/r1.out" 2>&1 || {
  cat "$W/r1.out"
  bad "restore 1 failed"
}
D1=$(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $t0}")
tail -12 "$W/r1.out"
r1q() { psql -h "$W/sock" -p 5545 -U postgres -d tkdemo -Atc "$1"; }
eq "RESTORE 1: row count is EXACTLY the state at T2" "$C2" "$(r1q 'select count(*) from events')"
eq "  no rows of batch b3/b4/b5" "0" "$(r1q "select count(*) from events where batch in ('b3','b4','b5')")"
eq "  batch b2 complete" "700" "$(r1q "select count(*) from events where batch='b2'")"
eq "  the later-dropped table is still there with 50 rows" "50" "$(r1q 'select count(*) from accidental')"
eq "  base #1 was chosen (base #2 finished after T2)" "1" "$(grep -c "using base backup $BASE1" "$W/r1.out")"
eq "  recovery finished, server is a normal primary" "f" "$(r1q 'select pg_is_in_recovery()')"
eq "  restored instance does NOT archive (archive_mode=off)" "off" "$(r1q 'show archive_mode')"
eq "  recovery settings were removed after promotion" "0" "$(grep -c tk-restore "$W/r1/postgresql.auto.conf")"
yes "  source server config was kept next to the restore" test -f "$W/r1.config-from-backup/postgresql.conf"
as_pg pg_ctl -D "$W/r1" -m fast -w stop >/dev/null

section "RESTORE 2: --latest (end of the archive) with the newest base"
t0=$(date +%s.%N)
RP --latest --data-dir "$W/r2" --port 5546 --socket-dir "$W/sock" >"$W/r2.out" 2>&1 || {
  cat "$W/r2.out"
  bad "restore 2 failed"
}
D2=$(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $t0}")
r2q() { psql -h "$W/sock" -p 5546 -U postgres -d tkdemo -Atc "$1"; }
eq "RESTORE 2: ALL rows are back" "$CL" "$(r2q 'select count(*) from events')"
eq "  the final batch is there" "102" "$(r2q "select count(*) from events where batch='b5'")"
eq "  the DROP TABLE (the later mistake) is replayed too: table gone" "0" "$(r2q "select count(*) from pg_tables where tablename='accidental'")"
eq "  base #2 was chosen" "1" "$(grep -c "using base backup $BASE2" "$W/r2.out")"
as_pg pg_ctl -D "$W/r2" -m fast -w stop >/dev/null

section "RESTORE 3: logical-mistake runbook - side instance just before the DROP, extract the table, re-import"
t0=$(date +%s.%N)
RP --target-time "$T4" --data-dir "$W/r3" --port 5547 --socket-dir "$W/sock" >"$W/r3.out" 2>&1 || {
  cat "$W/r3.out"
  bad "restore 3 failed"
}
D3=$(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $t0}")
r3q() { psql -h "$W/sock" -p 5547 -U postgres -d tkdemo -Atc "$1"; }
r2q() { psql -h "$W/sock" -p 5546 -U postgres -d tkdemo -Atc "$1"; }
eq "RESTORE 3: state just before the DROP: events" "$C4" "$(r3q 'select count(*) from events')"
eq "  accidental has its 50 rows" "50" "$(r3q 'select count(*) from accidental')"
# the "damaged live system" is played by the restored --latest instance (r2), where the table is gone
as_pg pg_ctl -D "$W/r2" -l "$W/sock/r2.log2" -o "-c port=5546 -c unix_socket_directories=$W/sock -c listen_addresses=localhost -c archive_mode=off" -w start >/dev/null
eq "  damaged system: table really is missing" "0" "$(r2q "select count(*) from pg_tables where tablename='accidental'")"
pg_dump -h "$W/sock" -p 5547 -U postgres -d tkdemo -t accidental >"$W/accidental.sql"
yes "  pg_dump -t accidental from the side instance works" test -s "$W/accidental.sql"
psql -h "$W/sock" -p 5546 -U postgres -d tkdemo -q -f "$W/accidental.sql" >/dev/null
eq "  table re-imported into the damaged instance: 50 rows back" "50" "$(r2q 'select count(*) from accidental')"
as_pg pg_ctl -D "$W/r2" -m fast -w stop >/dev/null
as_pg pg_ctl -D "$W/r3" -m fast -w stop >/dev/null

section "RESTORE 4: --pause at T1 (inspect before promoting)"
RP --target-time "$T1" --pause --data-dir "$W/r4" --port 5548 --socket-dir "$W/sock" >"$W/r4.out" 2>&1 || {
  cat "$W/r4.out"
  bad "restore 4 failed"
}
r4q() { psql -h "$W/sock" -p 5548 -U postgres -d tkdemo -Atc "$1"; }
eq "RESTORE 4: paused at T1, still in recovery" "t" "$(r4q 'select pg_is_in_recovery()')"
eq "  row count exactly the state at T1" "$C1" "$(r4q 'select count(*) from events')"
eq "  replay is paused" "paused" "$(r4q 'select pg_get_wal_replay_pause_state()')"
r4q 'select pg_wal_replay_resume()' >/dev/null
promoted=0
for _ in $(seq 1 30); do
  [ "$(r4q 'select pg_is_in_recovery()')" = "f" ] && promoted=1 && break
  sleep 1
done
eq "  pg_wal_replay_resume() promotes it" "1" "$promoted"
as_pg pg_ctl -D "$W/r4" -m fast -w stop >/dev/null

eq "no restore wrote to the real archive (remote file count unchanged)" "$REMOTE_FILES_BEFORE" "$(find "$W/remote" -type f | wc -l)"
eq "restore 4 (--base with a wrong label): clean failure, exit 11" "11" "$(rc_of env TK_BACKUP_ENV="$W/backup.env" "$B/restore-pitr.sh" --latest --base 19990101T000000Z --data-dir "$W/r7" --port 5549 --socket-dir "$W/sock")"
r=$(rc_of env TK_BACKUP_ENV="$W/backup.env" "$B/restore-pitr.sh" --target-time "2026-01-01 00:00:00+00" --data-dir "$W/r5" --port 5549 --socket-dir "$W/sock")
eq "target time older than every base backup: clean failure, exit 11" "11" "$r"
r=$(rc_of env TK_BACKUP_ENV="$W/backup.env" "$B/restore-pitr.sh" --target-time "2099-01-01 00:00:00+00" --data-dir "$W/r6" --port 5549 --socket-dir "$W/sock" --timeout 60)
eq "target time beyond the archive: recovery aborts, nothing promoted silently (exit 11)" "11" "$r"

# ---------------------------------------------------------------------------------------------
section "RESULTS"
echo "  Restore 1 (PITR to T2, includes download + decrypt + WAL replay): ${D1} s"
echo "  Restore 2 (--latest):                                            ${D2} s"
echo "  Restore 3 (side instance before the DROP):                       ${D3} s"
echo "  Remote archive: $(find "$W/remote/wal" -type f -name '*.gz.age' | wc -l) WAL files, $(du -sk "$W/remote" | cut -f1) KB total, bases: $(ls "$W/remote/base" | grep -c '\.json$')"
echo
echo "ASSERTIONS: $PASS passed, $FAIL failed"
if [ "$FAIL" -ne 0 ]; then
  echo "PITR REHEARSAL FAILED" >&2
  exit 1
fi
echo "PITR REHEARSAL OK"
