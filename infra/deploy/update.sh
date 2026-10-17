#!/usr/bin/env bash
# One-command update of the server, and the way back.
#   bash infra/deploy/update.sh              newest version of main
#   bash infra/deploy/update.sh <commit>     a specific version (the way back)
#   bash infra/deploy/update.sh --previous   the version that ran before the current one
#   bash infra/deploy/update.sh --list       the last 10 healthy deploys
# It fetches the version, rebuilds and restarts (Caddy too when its settings file changed), checks that the site answers, writes the deploy log, and only then frees the old
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

# Caddy reads its settings file only when it starts, and `up -d` leaves it running when its image did not change. So compare the
# file Caddy is using with the one just fetched, and restart Caddy (a few seconds, the certificate is kept) only if they differ.
echo "== checking the Caddy settings"
caddy_file=$(grep '^CADDYFILE=' "$ENV_FILE" | cut -d= -f2 || true)
caddy_file=${caddy_file:-./Caddyfile}
case "$caddy_file" in /*) ;; *) caddy_file=infra/deploy/$caddy_file ;; esac
wanted=$(cksum <"$caddy_file")
running=$("${COMPOSE[@]}" exec -T caddy cat /etc/caddy/Caddyfile 2>/dev/null | cksum || true)
caddy_warning=""
if [ "$wanted" != "$running" ]; then
  # A mistake in the file would make Caddy fail to start and take the site down, so check it first (this runs the same Caddy
  # image, offline). If it is invalid the running Caddy keeps its old, working settings.
  if docker run --rm -e DOMAIN="$DOMAIN" -v "$PWD/$caddy_file:/etc/caddy/Caddyfile:ro" caddy:2 caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    echo "Caddy settings changed: restarting Caddy"
    "${COMPOSE[@]}" restart caddy
  else
    caddy_warning="The new Caddy settings ($caddy_file) are NOT valid, so Caddy was not restarted and keeps its old settings. Tell the developer."
    echo "WARNING: $caddy_warning" >&2
  fi
else
  echo "Caddy settings unchanged"
fi

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
[ -z "$caddy_warning" ] || echo "WARNING: $caddy_warning" >&2
echo "Update finished: $(git log -1 --format='%h %s')"
