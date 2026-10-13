#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu server: installs Docker, writes infra/deploy/.env with random secrets,
# starts everything and creates the first Organization Admin.
#   sudo bash infra/deploy/setup.sh                 (uses <server-ip>.sslip.io as the address)
#   sudo DOMAIN=work.example.mn bash infra/deploy/setup.sh   (your own domain, DNS A record must point here)
set -euo pipefail
cd "$(dirname "$0")/../.."
ENV_FILE=infra/deploy/.env
COMPOSE=(docker compose --env-file "$ENV_FILE" -f infra/deploy/docker-compose.yml)

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

if [ ! -f "$ENV_FILE" ]; then
  if [ -z "${DOMAIN:-}" ]; then
    ip=$(curl -fsS https://api.ipify.org)
    DOMAIN="${ip//./-}.sslip.io"
  fi
  umask 077
  {
    echo "DOMAIN=$DOMAIN"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
    echo "APP_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
    echo "DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)"
    echo "ATTESTATION_MODE=disabled"
  } >"$ENV_FILE"
  echo "Wrote $ENV_FILE (keep a private copy: losing DATA_ENCRYPTION_KEY makes stored 2FA secrets unreadable)."
fi

"${COMPOSE[@]}" up -d --build postgres migrate
bash infra/deploy/app-login.sh >/dev/null
"${COMPOSE[@]}" up -d --build

echo "Waiting for the API..."
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api node -e "fetch('http://localhost:3001/v1/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 3
done
[ "${ok:-0}" = 1 ] || { echo "API did not become ready: ${COMPOSE[*]} logs api"; exit 1; }

"${COMPOSE[@]}" exec -T postgres psql -U timekeeper -d timekeeper -v ON_ERROR_STOP=1 \
  <infra/deploy/baseline-310.sql >/dev/null
echo
echo "Create the first Organization Admin (replace the name):"
echo "  ${COMPOSE[*]} exec api node apps/api/dist/cli/create-user.js --org 310 --username admin --name \"Admin\" --role ORG_ADMIN"
echo
echo "Address: https://$(grep '^DOMAIN=' "$ENV_FILE" | cut -d= -f2)"
