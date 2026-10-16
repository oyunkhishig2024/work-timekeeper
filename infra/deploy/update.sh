#!/usr/bin/env bash
# One-command update of the server, and the way back.
#   bash infra/deploy/update.sh              newest version of main
#   bash infra/deploy/update.sh <commit>     a specific version (the way back)
#   bash infra/deploy/update.sh --previous   the version that ran before the current one
#   bash infra/deploy/update.sh --list       the last 10 healthy deploys
# It fetches the version, rebuilds and restarts, checks that the site answers, writes the deploy log, and only then frees the old
# build cache (every build leaves several GB behind). Running containers and data volumes are never touched.
# Going back does NOT undo database changes: the older code runs on the newer database. That is safe when the newer migrations
# only added things (the usual case); the script lists the migrations it is skipping so you can judge. Add --yes to skip the question.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/deploy/.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/deploy/docker-compose.yml)
LOG=${DEPLOY_LOG:-/var/log/timekeeper-deploys.log}
KEEP=${KEEP_CACHE_HOURS:-24}

target=""
assume_yes=0
for arg in "$@"; do
  case "$arg" in
    --yes) assume_yes=1 ;;
    --list)
      if [ -f "$LOG" ]; then tail -n 10 "$LOG"; else echo "No deploy has been logged yet."; fi
      exit 0
      ;;
    --previous) target=PREVIOUS ;;
    -*) echo "Unknown option $arg" >&2; exit 1 ;;
    *) target=$arg ;;
  esac
done

DOMAIN=$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)
current=$(git rev-parse HEAD)

if [ "$target" = PREVIOUS ]; then
  # newest log entries first: the first sha different from the running one
  target=$(tac "$LOG" 2>/dev/null | awk -v cur="$current" '$2 != cur {print $2; exit}' || true)
  if [ -z "$target" ]; then
    echo "No earlier healthy deploy in $LOG. Pick a commit from: git log --oneline | head" >&2
    exit 1
  fi
fi

echo "== fetching"
git fetch origin
if [ -n "$target" ]; then
  git rev-parse --verify --quiet "$target^{commit}" >/dev/null || { echo "Unknown version: $target" >&2; exit 1; }
  target_sha=$(git rev-parse "$target^{commit}")
  skipped=$(git diff --name-only --diff-filter=A "$target_sha" "$current" -- apps/api/db/migrations || true)
  if [ -n "$skipped" ]; then
    echo "Database changes made after that version stay in place (the older code will run on the newer database):"
    # shellcheck disable=SC2001
    echo "$skipped" | sed 's/^/    /'
    if [ "$assume_yes" -ne 1 ]; then
      read -r -p "Continue? Type yes: " answer
      [ "$answer" = yes ] || { echo "Cancelled."; exit 1; }
    fi
  fi
  echo "== going to $(git log -1 --format='%h %s' "$target_sha")"
  git checkout --detach "$target_sha"
else
  # back from an earlier rollback (detached) to the branch, then the newest version
  if ! git symbolic-ref -q HEAD >/dev/null; then git checkout main; fi
  git pull --ff-only
fi

echo "== rebuilding and restarting (takes a few minutes)"
"${COMPOSE[@]}" up -d --build

echo "== checking that the site answers"
ok=0
for _ in $(seq 1 30); do
  if curl -fsS -m 10 -o /dev/null "https://$DOMAIN/v1/health"; then
    ok=1
    break
  fi
  sleep 4
done
if [ "$ok" -ne 1 ]; then
  echo "The site did not answer. Nothing was logged or cleaned up. Look at: ${COMPOSE[*]} logs --tail 50 api web" >&2
  echo "To go back to the version before: bash infra/deploy/update.sh --previous" >&2
  exit 1
fi

echo "$(date -u +%FT%TZ) $(git rev-parse HEAD) $(git log -1 --format=%s)" >>"$LOG" 2>/dev/null || true

echo "== freeing old build cache and unused images"
docker builder prune -f --filter "until=${KEEP}h" | tail -n 1
docker image prune -f | tail -n 1
df -h / | tail -n 1
echo "Update finished: $(git log -1 --format='%h %s')"
