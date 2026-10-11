# Server package (Docker + HTTPS)

Runs the whole service on one small Ubuntu server (2 GB RAM is enough for a pilot): PostgreSQL, API, worker,
admin web app and Caddy (automatic HTTPS). Only ports 80 and 443 are open; the database is not reachable
from the internet.

## First install (on the server, as root)

```bash
git clone https://github.com/oyunkhishig2024/work-timekeeper.git
cd work-timekeeper
sudo bash infra/deploy/setup.sh
```

- Without `DOMAIN` the address is `<server-ip-with-dashes>.sslip.io` (free, valid HTTPS certificate, good for a pilot).
  With your own domain: point its DNS A record at the server, then `sudo DOMAIN=work.example.mn bash infra/deploy/setup.sh`.
- The script writes `infra/deploy/.env` with random secrets. **Back this file up privately**: losing
  `DATA_ENCRYPTION_KEY` makes stored 2FA secrets unreadable.
- It starts everything, creates tenant `310` and prints the command that creates the first Organization Admin.

## Update after a code change

```bash
git pull
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml up -d --build
```

Migrations run automatically (`migrate` service) before the API starts.

`baseline-310.sql` (run by `setup.sh`, safe to repeat) gives tenant 310 the default reasons, attendance rules, a Mon–Fri 08:30–17:30 working week and a DRAFT consent text. Without a working week nobody is expected and phones watch no places. There is no admin screen for the working week yet; change it with SQL (a new `working_week_version`).

## Mobile app

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/eas.json` (profile `preview`) to `https://<address>` before building.

## Not covered here

Backups (see `infra/backup/README.md`), Cloudflare/WAF in front (see `docs/security/README.md`), monitoring.
Local files are kept in the Docker volumes `pgdata`, `storage`, `caddy_data`. `ATTESTATION_MODE=disabled` is for the pilot only.
