# Cloudflare in front of the pilot server (DigitalOcean + Caddy)

The general design is in [waf-hostinger-cloudflare.md](waf-hostinger-cloudflare.md) (written for a Hostinger VPS with nginx).
This page is the same idea for the server we actually run: a **DigitalOcean droplet with Docker and Caddy**
(`infra/deploy`). It needs **your own domain** (a `*.sslip.io` address cannot be put behind Cloudflare).

```
users / phones / admin browsers
        |
  Cloudflare   (DDoS absorption, WAF, rate limits, hides the server address)
        |   only Cloudflare addresses may reach ports 80 / 443  (DigitalOcean Cloud Firewall)
  Droplet: ufw (22, 80, 443) + Caddy -> api / web -> PostgreSQL (internal network only)
```

## Steps (about 45 minutes, in this order)

1. **Cloudflare account** with two-step login on (it can take the whole service offline). Add the domain (free plan).
   At the registrar change the nameservers to the two Cloudflare gives you. Wait until Cloudflare says "Active".
2. **DNS:** one `A` record, name = the host you use (e.g. `work`), value = the droplet IP, **Proxied (orange cloud)**.
   Delete any other record that shows the server IP.
3. **On the server** set the new address and reload (see `infra/deploy/README.md`):
   `DOMAIN=work.example.mn` in `infra/deploy/.env`, then
   `docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml up -d`.
   Open `https://work.example.mn` and check it works. In Cloudflare SSL/TLS set the mode to **Full (strict)**.
   Rebuild the phone app with the new address (`apps/mobile/eas.json`) when you change the domain.
4. **Lock the server to Cloudflare** (the step people forget). In DigitalOcean: Networking → Firewalls → Create/edit your
   firewall → Inbound rules: **HTTP 80** and **HTTPS 443** with sources = Cloudflare's address ranges only (copy them from
   <https://www.cloudflare.com/ips/>, IPv4 and IPv6), **SSH 22** = your own address(es) if they are fixed. Remove "All IPv4 / All IPv6" from 80 and 443.
   Why here and not in ufw: Docker publishes ports around ufw, so the cloud firewall is the reliable place.
   **Check:** from your Mac `curl -m 10 -k https://<droplet-IP>/v1/health` must time out, while `https://work.example.mn/v1/health` answers.
5. **Real visitor address.** Only after step 4 works, in `infra/deploy/.env` add `CADDYFILE=./Caddyfile.cloudflare` and run the same
   `docker compose … up -d`. Without it every visitor looks like Cloudflare and the adaptive protection could ban everybody; with it but
   without step 4 the header could be forged. Keep `TRUST_PROXY=1` (one proxy: Caddy). Test: sign in with a wrong password a few times from
   your phone and from your Mac: the `audit_log` / API log must show different addresses, not Cloudflare's.
6. **WAF rules:** Security → WAF → Managed rules on. Then the custom rules and rate limits of `infra/cloudflare/waf-rules.json`
   (edit the host name; `infra/cloudflare/apply.sh plan`, then `log` mode for a week, then `enforce`), exactly as in section 2.4 of the general document.
7. **Uptime check from outside** (see [monitoring-and-incidents.md](../operations/monitoring-and-incidents.md)).

Rollback: remove `CADDYFILE` from `.env`, `up -d`, set the DNS record to "DNS only" (grey cloud) and re-open 80/443 in the DigitalOcean firewall.
