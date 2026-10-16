#!/usr/bin/env bash
# Offline test of update.sh with fake git, docker, curl and sleep: update, cleanup order, the deploy log, rollback and its warnings.
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

# fake git: HEAD is a file; "main" moves on `pull`; fetch/checkout are logged
cat >"$t/bin/git" <<'FAKE'
#!/usr/bin/env bash
echo "git $*" >>"$T_LOG"
case "$1" in
  rev-parse)
    case "$*" in
      *"--verify"*) [ "${*: -1}" != "nosuch^{commit}" ] ;;
      *"^{commit}"*) ref=${*: -1}; echo "${ref%^\{commit\}}-sha" | sed 's/^\(.\{40\}\).*/\1/' ;;
      *) cat "$T_HEAD" ;;
    esac ;;
  pull) echo newsha >"$T_HEAD" ;;
  checkout) [ "$2" = --detach ] && echo "$3" >"$T_HEAD" || echo mainsha >"$T_HEAD" ;;
  symbolic-ref) [ -z "${T_DETACHED:-}" ] ;;
  diff) printf '%s' "${T_MIGRATIONS:-}" ;;
  log) echo "abc1234 a change" ;;
  fetch) ;;
esac
FAKE
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\necho "docker $*" >>"$T_LOG"\n' >"$t/bin/docker"
# shellcheck disable=SC2016
printf '#!/usr/bin/env bash\nexit "${T_CURL_RC:-0}"\n' >"$t/bin/curl"
printf '#!/usr/bin/env bash\nexit 0\n' >"$t/bin/sleep"
chmod +x "$t/bin/"*
export PATH="$t/bin:$PATH" T_LOG="$t/log" T_HEAD="$t/head" DEPLOY_LOG="$t/deploys.log"
echo oldsha >"$T_HEAD"
update() { bash "$t/repo/infra/deploy/update.sh" "$@" >"$t/out" 2>&1; }

echo "== normal update"
: >"$T_LOG"
update
check "fetches, then pulls" "$(grep -c '^git pull --ff-only' "$T_LOG")" 1
check "rebuilds" "$(grep -c 'up -d --build' "$T_LOG")" 1
check "cleans the build cache after the check" "$(grep -c 'builder prune -f --filter until=24h' "$T_LOG")" 1
check "logs the healthy deploy" "$(grep -c ' newsha ' "$DEPLOY_LOG")" 1
check "never removes volumes" "$(grep -c 'volume\|system prune' "$T_LOG")" 0

echo "== a second update, then --previous goes back to the first"
echo "2026-10-15T00:00:00Z oldsha an older change" >"$DEPLOY_LOG.new"
cat "$DEPLOY_LOG" >>"$DEPLOY_LOG.new"
mv "$DEPLOY_LOG.new" "$DEPLOY_LOG"
: >"$T_LOG"
update --previous --yes
check "checks out the earlier version" "$(grep -c '^git checkout --detach oldsha' "$T_LOG")" 1
check "rebuilds it" "$(grep -c 'up -d --build' "$T_LOG")" 1
check "--list shows the log" "$(bash "$t/repo/infra/deploy/update.sh" --list | wc -l | tr -d ' ')" 3

echo "== going back over a newer migration warns and asks"
: >"$T_LOG"
echo newsha >"$T_HEAD"
rc=0
T_MIGRATIONS=$'apps/api/db/migrations/0099_new.sql\n' bash "$t/repo/infra/deploy/update.sh" oldsha >"$t/out" 2>&1 <<<"no" || rc=$?
check "lists the skipped migration" "$(grep -c '0099_new.sql' "$t/out")" 1
check "answering no cancels" "$rc" 1
check "and changes nothing" "$(grep -c 'up -d --build' "$T_LOG")" 0

echo "== an unknown version is refused"
rc=0
bash "$t/repo/infra/deploy/update.sh" nosuch >"$t/out" 2>&1 || rc=$?
check "unknown version fails" "$rc" 1

echo "== a normal update after a rollback returns to main first"
: >"$T_LOG"
T_DETACHED=1 update
check "checks out main, then pulls" "$(grep -c '^git checkout main' "$T_LOG")$(grep -c '^git pull' "$T_LOG")" 11

echo "== the site does not answer"
: >"$T_LOG"
: >"$DEPLOY_LOG"
rc=0
T_CURL_RC=22 bash "$t/repo/infra/deploy/update.sh" >"$t/out" 2>&1 || rc=$?
check "update fails" "$rc" 1
check "nothing is logged" "$(wc -c <"$DEPLOY_LOG" | tr -d ' ')" 0
check "no cleanup after a failed update" "$(grep -c 'prune' "$T_LOG")" 0
check "it points at --previous" "$(grep -c -- '--previous' "$t/out")" 1

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
