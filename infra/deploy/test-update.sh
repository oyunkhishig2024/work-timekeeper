#!/usr/bin/env bash
# Offline test of update.sh with fake git, docker, curl and sleep: the cleanup runs after a healthy update and never after a failed one.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (got '$2', want '$3')"; fi; }

mkdir -p "$t/bin" "$t/repo/infra/deploy"
cp "$here/update.sh" "$t/repo/infra/deploy/"
echo "DOMAIN=example.test" >"$t/repo/infra/deploy/.env"
for cmd in git docker; do
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$T_LOG"\n' "$cmd" >"$t/bin/$cmd"
done
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nexit "${T_CURL_RC:-0}"\n' >"$t/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$t/bin/sleep"
chmod +x "$t/bin/"*
export PATH="$t/bin:$PATH" T_LOG="$t/log"

echo "== healthy update"
: >"$T_LOG"
T_CURL_RC=0 bash "$t/repo/infra/deploy/update.sh" >/dev/null
check "pulls first" "$(sed -n 1p "$T_LOG")" "git pull --ff-only"
check "then rebuilds" "$(sed -n 2p "$T_LOG" | grep -c 'up -d --build')" 1
check "then prunes the build cache older than 24h" "$(grep -c 'builder prune -f --filter until=24h' "$T_LOG")" 1
check "and unused images" "$(grep -c 'image prune -f' "$T_LOG")" 1
check "never removes volumes" "$(grep -c 'volume\|system prune' "$T_LOG")" 0

echo "== the site does not answer"
: >"$T_LOG"
rc=0
T_CURL_RC=22 bash "$t/repo/infra/deploy/update.sh" >/dev/null 2>&1 || rc=$?
check "update fails" "$rc" 1
check "no cleanup after a failed update" "$(grep -c 'prune' "$T_LOG")" 0

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
