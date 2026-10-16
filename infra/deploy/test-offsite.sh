#!/usr/bin/env bash
# Offline test of the off-server copy scripts with a fake rclone (it "uploads" into a local folder).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (got '$2', want '$3')"; fi; }

mkdir -p "$t/bin" "$t/remote" "$t/pitr/wal" "$t/dest" "$t/repo/infra/deploy"
cp "$here/offsite-setup.sh" "$here/offsite-sync.sh" "$here/backup.sh" "$t/repo/infra/deploy/"
touch "$t/repo/infra/deploy/.env" "$t/repo/infra/deploy/docker-compose.yml"
echo "wal-1" >"$t/pitr/wal/0001.gz.age"
touch -d '-5 minutes' "$t/pitr/wal/0001.gz.age"

# fake rclone: b2:BUCKET/x  ->  $T_REMOTE/BUCKET/x ; supports lsf, rcat, cat, deletefile, copy, copyto
cat >"$t/bin/rclone" <<'FAKE'
#!/usr/bin/env bash
args=("$@")
while [ "${args[0]:-}" = --config ]; do args=("${args[@]:2}"); done
cmd=${args[0]}
map() { echo "$T_REMOTE/${1#b2:}"; }
echo "rclone ${args[*]}" >>"$T_LOG"
[ -z "${T_RCLONE_FAIL:-}" ] || exit 1
case "$cmd" in
  lsf) mkdir -p "$(map "${args[1]}")"; ls "$(map "${args[1]}")" ;;
  rcat) mkdir -p "$(dirname "$(map "${args[1]}")")"; cat >"$(map "${args[1]}")" ;;
  cat) cat "$(map "${args[1]}")" ;;
  deletefile) rm -f "$(map "${args[1]}")" ;;
  copyto) mkdir -p "$(dirname "$(map "${args[2]}")")"; cp "${args[1]}" "$(map "${args[2]}")" ;;
  copy) mkdir -p "$(map "${args[2]}")"; cp -r "${args[1]}/." "$(map "${args[2]}")/" ;;
esac
FAKE
chmod +x "$t/bin/rclone"
cat >"$t/conf.env" <<EOC
REPO_DIR=$t/repo
BACKUP_AGE_RECIPIENT=age1unused
BACKUP_DIR=$t/dest
PITR_DIR=$t/pitr
EOC
export PATH="$t/bin:$PATH" T_REMOTE="$t/remote" T_LOG="$t/log" TK_BACKUP_ENV="$t/conf.env" TK_ALLOW_NONROOT=1
export OFFSITE_CONF_DIR="$t/etc" OFFSITE_CRON_DIR="$t/cron" OFFSITE_SKIP_FIRST_RUN=1 OFFSITE_STATE="$t/state" OFFSITE_LOCK="$t/lock"
mkdir -p "$t/cron"

echo "== setup with a typed bucket and key"
printf 'my-bucket\nKEYID123\nSECRETKEY456\n' | bash "$t/repo/infra/deploy/offsite-setup.sh" >"$t/out" 2>&1 || { cat "$t/out"; exit 1; }
check "stores the key privately" "$(stat -c %a "$t/etc/rclone.conf")" 600
check "key is in the rclone config, not in the env file" "$(grep -c SECRETKEY456 "$t/etc/rclone.conf")$(grep -c SECRETKEY456 "$t/conf.env")" 10
check "points the nightly copy at the bucket" "$(grep -c '^BACKUP_REMOTE=b2:my-bucket/nightly' "$t/conf.env")" 1
check "points the point-in-time copy at the bucket" "$(grep -c '^OFFSITE_PITR_REMOTE=b2:my-bucket/pitr' "$t/conf.env")" 1
check "installs the cron jobs" "$(grep -c offsite-sync.sh "$t/cron/timekeeper-offsite")" 2
check "the test file is removed again" "$(find "$t/remote/my-bucket/test" -type f | wc -l | tr -d ' ')" 0

echo "== point-in-time copy"
bash "$t/repo/infra/deploy/offsite-sync.sh" full
check "uploads the log files" "$(cat "$t/remote/my-bucket/pitr/wal/0001.gz.age")" wal-1
check "records success" "$(cut -d' ' -f1 "$t/state")" ok
: >"$t/log"
bash "$t/repo/infra/deploy/offsite-sync.sh" recent
check "the 10-minute run only looks at recent files" "$(grep -c -- '--max-age 2d' "$t/log")" 1
check "and never deletes on the remote" "$(grep -c 'sync\|delete\|purge' "$t/log")" 0
rc=0
T_RCLONE_FAIL=1 bash "$t/repo/infra/deploy/offsite-sync.sh" recent 2>/dev/null || rc=$?
check "a failed upload is an error" "$rc" 1
check "and is recorded" "$(cut -d' ' -f1 "$t/state")" fail

echo "== the nightly backup copies its archive off the server (fake docker)"
cat >"$t/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"pg_dump"*) echo "dump" ;;
  *"tar -C"*) tar -C "$T_STORAGE" -cf - . ;;
esac
FAKE
chmod +x "$t/bin/docker"
mkdir -p "$t/storage"
echo scan >"$t/storage/a.pdf"
export T_STORAGE="$t/storage"
# the fake age: copies stdin
printf '#!/usr/bin/env bash\ncat\n' >"$t/bin/age"
chmod +x "$t/bin/age"
rc=0
bash "$t/repo/infra/deploy/backup.sh" >"$t/out2" 2>&1 || rc=$?
check "backup succeeds" "$rc" 0
check "status ok" "$(cut -d' ' -f1 "$t/dest/.last-status")" ok
check "archive is in the bucket" "$(find "$t/remote/my-bucket/nightly" -name 'tk-*.tar.age' | wc -l | tr -d ' ')" 1
check "records the off-server copy" "$([ -s "$t/dest/.last-offsite" ] && echo yes)" yes
sleep 1
rc=0
T_RCLONE_FAIL=1 bash "$t/repo/infra/deploy/backup.sh" >"$t/out3" 2>&1 || rc=$?
check "an upload failure ends with exit 4" "$rc" 4
check "status says offsite-failed" "$(cut -d' ' -f1 "$t/dest/.last-status")" offsite-failed
check "the local backup is kept" "$(find "$t/dest" -name 'tk-*.tar.age' | wc -l | tr -d ' ')" 2

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
