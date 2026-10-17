#!/usr/bin/env bash
# Offline test of offsite-harden.sh with a fake Backblaze API (curl), a fake rclone and a fake offsite-sync.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (got '$2', want '$3')"; fi; }

mkdir -p "$t/bin" "$t/repo/infra/deploy" "$t/etc"
cp "$here/offsite-harden.sh" "$t/repo/infra/deploy/"
# fake offsite-sync.sh: succeeds or fails on demand
printf '#!/usr/bin/env bash\necho sync >>"$T_LOG"\nexit "${T_SYNC_RC:-0}"\n' >"$t/repo/infra/deploy/offsite-sync.sh"

# fake curl: the master key arrives on stdin (-K -), the URL is the last argument; every call is logged WITHOUT stdin
cat >"$t/bin/curl" <<'FAKE'
#!/usr/bin/env bash
cat >/dev/null
url=${*: -1}
echo "curl $*" >>"$T_LOG"
case "$url" in
  */b2_authorize_account)
    if [ -n "${T_AUTH_FAIL:-}" ]; then echo '{"status":401,"code":"bad_auth_token","message":"Invalid credentials"}'; exit 0; fi
    echo '{"accountId":"acc1","authorizationToken":"tok1","apiInfo":{"storageApi":{"apiUrl":"https://api001.test"}}}' ;;
  */b2_list_buckets)
    if [ -n "${T_NO_BUCKET:-}" ]; then echo '{"buckets":[]}'; else echo '{"buckets":[{"bucketId":"bid1","bucketName":"my-bucket"}]}'; fi ;;
  */b2_create_key) echo '{"applicationKeyId":"NEWKEYID","applicationKey":"NEWSECRET789"}' ;;
  */b2_delete_key) echo '{}' ;;
esac
FAKE
# fake rclone: lsf, rcat, cat, deletefile (refused unless T_DELETE_OK); logs which key file it ran with
cat >"$t/bin/rclone" <<'FAKE'
#!/usr/bin/env bash
args=("$@")
conf=""
while [ "${args[0]:-}" = --config ]; do conf=${args[1]}; args=("${args[@]:2}"); done
echo "rclone ${args[*]} key=$(grep '^key' "$conf" | cut -d' ' -f3)" >>"$T_LOG"
case "${args[0]}" in
  lsf) ;;
  rcat) cat >"$T_PROBE" ;;
  cat) cat "$T_PROBE" ;;
  deletefile) [ -n "${T_DELETE_OK:-}" ] || exit 1 ;;
esac
FAKE
chmod +x "$t/bin/"*

cat >"$t/conf.env" <<EOC
BACKUP_REMOTE=b2:my-bucket/nightly
RCLONE_CONFIG=$t/etc/rclone.conf
EOC
export PATH="$t/bin:$PATH" T_LOG="$t/log" T_PROBE="$t/probe" TK_BACKUP_ENV="$t/conf.env" TK_ALLOW_NONROOT=1
export B2_API=https://api.test
run() { printf 'MASTERID\nMASTERSECRET123\n' | bash "$t/repo/infra/deploy/offsite-harden.sh" >"$t/out" 2>&1; }
reset_conf() { printf '[b2]\ntype = b2\naccount = OLDID\nkey = OLDSECRET\n' >"$t/etc/rclone.conf"; chmod 600 "$t/etc/rclone.conf"; : >"$T_LOG"; }

echo "== success"
reset_conf
run
check "the new key replaces the old one" "$(grep -c NEWSECRET789 "$t/etc/rclone.conf")$(grep -c OLDSECRET "$t/etc/rclone.conf")" 10
check "the config stays private" "$(stat -c %a "$t/etc/rclone.conf")" 600
check "the old key file is gone" "$(find "$t/etc" -name "*.prev" | wc -l | tr -d ' ')" 0
check "a regular copy was run with it" "$(grep -c '^sync' "$T_LOG")" 1
check "the key that was created is not removed" "$(grep -c b2_delete_key "$T_LOG")" 0
check "the key cannot delete or manage keys" "$(grep -c 'deleteFiles\|writeKeys\|listKeys' "$T_LOG")" 0
check "it can write, list and read" "$(grep -c 'writeFiles' "$T_LOG")" 1
check "the key is limited to the bucket" "$(grep -c 'bucketIds' "$T_LOG")" 1
check "the master key never reaches a file or the call arguments" "$(grep -rc MASTERSECRET123 "$t/etc" "$T_LOG" "$t/out" | awk -F: '{s+=$2} END {print s}')" 0
check "it says what to do next" "$(grep -c 'delete the OLD key' "$t/out")" 1

echo "== the new key could delete: refused, nothing changes"
reset_conf
rc=0
T_DELETE_OK=1 run || rc=$?
check "fails" "$rc" 1
check "the old key is still in place" "$(grep -c OLDSECRET "$t/etc/rclone.conf")" 1
check "the unsafe key is removed again" "$(grep -c b2_delete_key "$T_LOG")" 1
check "no copy was run" "$(grep -c '^sync' "$T_LOG")" 0

echo "== the regular copy fails with the new key: the old key comes back"
reset_conf
rc=0
T_SYNC_RC=1 run || rc=$?
check "fails" "$rc" 1
check "the old key is restored" "$(grep -c OLDSECRET "$t/etc/rclone.conf")$(grep -c NEWSECRET789 "$t/etc/rclone.conf")" 10
check "the new key is removed" "$(grep -c b2_delete_key "$T_LOG")" 1

echo "== Backblaze refuses the master key"
reset_conf
rc=0
T_AUTH_FAIL=1 run || rc=$?
check "fails with Backblaze's reason" "$rc$(grep -c 'Invalid credentials' "$t/out")" 11
check "no key was created" "$(grep -c b2_create_key "$T_LOG")" 0
check "the old key is untouched" "$(grep -c OLDSECRET "$t/etc/rclone.conf")" 1

echo "== the bucket is not in this account"
reset_conf
rc=0
T_NO_BUCKET=1 run || rc=$?
check "fails" "$rc" 1
check "no key was created" "$(grep -c b2_create_key "$T_LOG")" 0

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
