#!/usr/bin/env bash
# Server firewall (ufw): everything from the internet is blocked except SSH (22), HTTP (80) and HTTPS (443).
#   sudo bash infra/deploy/firewall.sh
# Safe to repeat. SSH stays open (and rate limited) so you cannot lock yourself out.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo bash infra/deploy/firewall.sh" >&2
  exit 1
fi

if ! command -v ufw >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq ufw
fi

ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'SSH (rate limited)'
ufw allow 80/tcp comment 'HTTP (certificate + redirect)'
ufw allow 443/tcp comment 'HTTPS'
ufw allow 443/udp comment 'HTTP/3'
ufw --force enable
ufw status verbose

# Automatic security updates for the operating system.
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  apt-get install -y -qq unattended-upgrades
fi
echo
echo "Firewall is on. Docker publishes only Caddy's ports 80 and 443 (see docker-compose.yml)."
