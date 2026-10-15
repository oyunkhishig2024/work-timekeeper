#!/usr/bin/env bash
# Offline test of backup.sh / restore-test.sh with a fake `docker` (no containers needed). Needs local PostgreSQL
# client tools and a server the current user can create databases on, plus age and tar.
#   bash infra/deploy/test-backup-scripts.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
t=$(mktemp -d)
db=tkbk_test_$$
trap 'dropdb --if-exists "$db" >/dev/null 2>&1 || true; rm -rf "$t"' EXIT
pass=0
fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "  PASS  $1"; else fail=$((fail + 1)); echo "  FAIL  $1 (got '$2', want '$3')"; fi; }

mkdir -p "$t/bin" "$t/storage/consent" "$t/repo/infra/deploy" "$t/dest"
cp "$here/backup.sh" "$here/restore-test.sh" "$t/repo/infra/deploy/"
touch "$t/repo/infra/deploy/.env" "$t/repo/infra/deploy/docker-compose.yml"
echo scan >"$t/storage/consent/a.pdf"
age-keygen -o "$t/key.txt" 2>"$t/pub.txt"
recipient=$(sed -n 's/^Public key: //p' "$t/pub.txt")
printf 'REPO_DIR=%s\nBACKUP_AGE_RECIPIENT=%s\nBACKUP_DIR=%s\n' "$t/repo" "$recipient" "$t/dest" >"$t/conf.env"

createdb "$db"
psql -q -d "$db" -c "CREATE TABLE tenant(id int); CREATE TABLE employee(id int); CREATE TABLE device_event(id int);
  CREATE TABLE attendance_result(id int); CREATE TABLE consent_record(scan_object_key text);
  INSERT INTO consent_record VALUES ('consent/a.pdf');"

# Fake docker: "docker compose --env-file X -f Y exec -T <service> <command...>"
cat >"$t/bin/docker" <<FAKE
#!/usr/bin/env bash
args=("\$@")
i=0
while [ "\${args[\$i]}" != exec ]; do i=\$((i + 1)); done
svc=\${args[\$((i + 2))]}
cmd=("\${args[@]:\$((i + 3))}")
if [ "\$svc" = api ]; then
  [ -z "\${STUB_TAR_FAIL:-}" ] || { echo "tar: boom" >&2; exit 1; }
  exec "\${cmd[0]}" -C "$t/storage" "\${cmd[@]:3}"
fi
out=()
skip=0
for a in "\${cmd[@]}"; do
  if [ \$skip -eq 1 ]; then skip=0; continue; fi
  case "\$a" in -U) skip=1 ;; timekeeper) out+=("$db") ;; *) out+=("\$a") ;; esac
done
exec "\${out[@]}"
FAKE
chmod +x "$t/bin/docker"
export PATH="$t/bin:$PATH" TK_BACKUP_ENV="$t/conf.env"

echo "== backup with files"
rc=0
bash "$t/repo/infra/deploy/backup.sh" >"$t/out1" 2>&1 || rc=$?
check "backup exits 0" "$rc" 0
check "status is ok" "$(cut -d' ' -f1 "$t/dest/.last-status")" ok
# shellcheck disable=SC2012
b1=$(ls "$t"/dest/tk-*.tar.age | head -1)

echo "== restore test finds the scan"
rc=0
bash "$t/repo/infra/deploy/restore-test.sh" "$b1" "$t/key.txt" >"$t/out2" 2>&1 || rc=$?
check "restore test exits 0" "$rc" 0
grep -q "referenced: 1\|points at: 1; missing: 0" "$t/out2" && r=yes || r=no
check "restore test counted 1 scan, 0 missing" "$r" yes

echo "== restore test of the old backup is unaffected by later data"
psql -q -d "$db" -c "INSERT INTO consent_record VALUES ('consent/lost.pdf')"
rc=0
bash "$t/repo/infra/deploy/restore-test.sh" "$b1" "$t/key.txt" >"$t/out3" 2>&1 || rc=$?
check "old backup still passes" "$rc" 0

echo "== backup when the files cannot be archived"
sleep 1
rc=0
STUB_TAR_FAIL=1 bash "$t/repo/infra/deploy/backup.sh" >"$t/out4" 2>&1 || rc=$?
check "backup exits 3" "$rc" 3
check "status is partial" "$(cut -d' ' -f1 "$t/dest/.last-status")" partial
# shellcheck disable=SC2012
b2=$(ls -t "$t"/dest/tk-*.tar.age | head -1)
check "database part still saved" "$([ "$b2" != "$b1" ] && echo yes)" yes

echo "== restore test of a backup that lost its files"
psql -q -d "$db" -c "DELETE FROM consent_record WHERE scan_object_key='consent/lost.pdf'"
rc=0
bash "$t/repo/infra/deploy/restore-test.sh" "$b2" "$t/key.txt" >"$t/out5" 2>&1 || rc=$?
check "restore test fails (scan missing from files)" "$rc" 1
grep -q "uploaded-files archive" "$t/out5" && r=yes || r=no
check "failure says the files archive is unusable" "$r" yes

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
