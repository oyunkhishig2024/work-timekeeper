#!/usr/bin/env bash
# One-command update of the server: fetch the new version, rebuild and restart, check that the site answers, and only then
# free the old build cache. (Every build leaves several GB of cache behind; without this the disk fills within months.)
#   cd ~/work-timekeeper && bash infra/deploy/update.sh
# Build cache older than KEEP_CACHE_HOURS (default 24) and unused images are removed; running containers and data volumes never are.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV_FILE=infra/deploy/.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/deploy/docker-compose.yml)
DOMAIN=$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)
KEEP=${KEEP_CACHE_HOURS:-24}

echo "== fetching the new version"
git pull --ff-only

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
  echo "The site did not answer after the update. Nothing was cleaned up. Look at: ${COMPOSE[*]} logs --tail 50 api web" >&2
  exit 1
fi

echo "== freeing old build cache and unused images"
docker builder prune -f --filter "until=${KEEP}h" | tail -n 1
docker image prune -f | tail -n 1
df -h / | tail -n 1
echo "Update finished."
