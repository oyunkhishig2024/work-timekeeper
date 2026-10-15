#!/usr/bin/env bash
# Offline test of usage-report.sh with a fake `docker` that runs psql against a migrated test database (TEST_DATABASE_URL).
#   TEST_DATABASE_URL=postgres://... bash infra/deploy/test-usage-report.sh
set -euo pipefail
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a migrated test database}"
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
trap 'rm -rf "$t"' EXIT
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (got '$2', want '$3')"; fi; }

mkdir -p "$t/bin" "$t/repo/infra/deploy"
touch "$t/repo/infra/deploy/.env" "$t/repo/infra/deploy/docker-compose.yml"
cat >"$t/bin/docker" <<FAKE
#!/usr/bin/env bash
case "\$*" in
  *" logs "*) printf '%s\n' '{"event":"limit.device_rate"}' '{"event":"limit.device_rate"}' '{"event":"security.request_refused"}' ;;
  *" psql "*) shift_args=("\$@"); i=0; while [ "\${shift_args[\$i]}" != psql ]; do i=\$((i + 1)); done
              rest=("\${shift_args[@]:\$((i + 1))}"); out=()
              skip=0
              for a in "\${rest[@]}"; do
                if [ \$skip -eq 1 ]; then skip=0; continue; fi
                case "\$a" in -U|-d) skip=1 ;; *) out+=("\$a") ;; esac
              done
              exec psql "$TEST_DATABASE_URL" "\${out[@]}" ;;
esac
FAKE
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" TK_BACKUP_ENV=/nonexistent REPO_DIR="$t/repo" USAGE_STATE="$t/state" BACKUP_DIR="$t" PITR_DIR="$t" ALERT_WEBHOOK=

# the script asks for pg_database_size('timekeeper'): use the test database's own name
sed "s/pg_database_size('timekeeper')/pg_database_size(current_database())/" "$here/usage-report.sh" >"$t/usage-report.sh"

echo "== first run"
out=$(bash "$t/usage-report.sh")
# shellcheck disable=SC2001
echo "$out" | sed 's/^/    /'
check "has the organizations section" "$(grep -c 'Organizations (' <<<"$out")" 1
check "has the database size" "$(grep -c '^Database: [0-9]* MB' <<<"$out")" 1
check "counts the phone limits" "$(grep -c '2 phone limits, 1 blocked addresses' <<<"$out")" 1
check "writes the state file" "$([ -s "$t/state" ] && echo yes)" yes

echo "== a week later the growth line appears"
echo "1 $(($(date +%s) - 7 * 86400))" >"$t/state"
out2=$(bash "$t/usage-report.sh")
check "has a growth line" "$(grep -c '^Growth: about' <<<"$out2")" 1

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
