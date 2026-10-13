#!/usr/bin/env bash
# One-time (safe to repeat): gives the API and worker their own limited database login (tk_app) with a random password
# kept in infra/deploy/.env as APP_DB_PASSWORD. Run it BEFORE rebuilding when updating an existing server:
#   sudo bash infra/deploy/app-login.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=infra/deploy/.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/deploy/docker-compose.yml)

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }
if ! grep -q '^APP_DB_PASSWORD=' "$ENV_FILE"; then
  echo "APP_DB_PASSWORD=$(openssl rand -hex 24)" >>"$ENV_FILE"
  echo "Added APP_DB_PASSWORD to $ENV_FILE"
fi
password=$(grep '^APP_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)

"${COMPOSE[@]}" up -d postgres
for _ in $(seq 1 30); do
  "${COMPOSE[@]}" exec -T postgres pg_isready -U timekeeper -d timekeeper >/dev/null 2>&1 && break
  sleep 2
done

# The role is also created by migration 0032; creating it here first lets the password be set before the new API starts.
"${COMPOSE[@]}" exec -T postgres psql -U timekeeper -d timekeeper -v ON_ERROR_STOP=1 >/dev/null <<SQL
SELECT 'CREATE ROLE tk_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'tk_app') \gexec
ALTER ROLE tk_app PASSWORD '${password}';
SQL
echo "tk_app login ready. Now rebuild: ${COMPOSE[*]} up -d --build"
