#!/usr/bin/env bash
# Locks the Hostinger VPS down so that the web ports accept traffic ONLY from Cloudflare (and SSH only from your own addresses).
# Without this, an attacker who learns the VPS address can bypass the WAF and hit the server directly.
#
#   sudo ADMIN_IPS="203.0.113.10 203.0.113.11" ./allow-cloudflare-only.sh
#
# Uses ufw (Ubuntu). Run it again from cron (weekly) so new Cloudflare ranges are picked up. If you use Cloudflare Tunnel
# (cloudflared) you do not need 443 open at all: run with OPEN_WEB=no.
# CAUTION: Docker publishes ports around ufw. If the API runs in a container, bind it to 127.0.0.1 (-p 127.0.0.1:3001:3001).
# Make sure ADMIN_IPS is right BEFORE enabling, or you lock yourself out (Hostinger's browser terminal in hPanel still works).
set -euo pipefail

: "${ADMIN_IPS:?set ADMIN_IPS to the addresses allowed to use SSH, space separated}"
OPEN_WEB="${OPEN_WEB:-yes}"
SSH_PORT="${SSH_PORT:-22}"

command -v ufw >/dev/null || apt-get install -y ufw
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing

for ip in $ADMIN_IPS; do ufw allow from "$ip" to any port "$SSH_PORT" proto tcp comment "admin ssh"; done

if [ "$OPEN_WEB" = yes ]; then
  curl -fsS https://www.cloudflare.com/ips-v4 > "$tmp"; echo >> "$tmp"
  curl -fsS https://www.cloudflare.com/ips-v6 >> "$tmp"
  [ "$(wc -l < "$tmp")" -gt 5 ] || { echo "Could not download Cloudflare ranges; firewall left unchanged" >&2; exit 1; }
  while read -r cidr; do
    [ -n "$cidr" ] || continue
    ufw allow from "$cidr" to any port 443 proto tcp comment "cloudflare"
  done < "$tmp"
  # nginx realip include, same ranges
  { while read -r cidr; do [ -n "$cidr" ] && echo "set_real_ip_from $cidr;"; done < "$tmp"; } > /etc/nginx/cloudflare-realip.conf
  command -v nginx >/dev/null && nginx -t && systemctl reload nginx || true
fi

ufw --force enable
ufw status numbered
