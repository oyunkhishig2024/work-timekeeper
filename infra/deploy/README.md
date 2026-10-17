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
bash infra/deploy/update.sh
```

It pulls the new version, rebuilds and restarts (and restarts Caddy for a few seconds when its settings file `Caddyfile` changed, because Caddy only reads it at start; the new file is checked with `caddy validate` first and an invalid one is not applied), checks that the site answers, writes the deploy log (`/var/log/timekeeper-deploys.log`) and only then removes build cache older than 24 hours and unused images (every build leaves several GB behind; before this script existed the cache grew to 24 GB). If the site does not answer, nothing is logged or cleaned up and the script says how to go back.

**Going back to an earlier version:**

```bash
bash infra/deploy/update.sh --list           # the last 10 healthy deploys (time, commit, what changed)
bash infra/deploy/update.sh --previous       # the version that ran before the current one
bash infra/deploy/update.sh <commit>         # any commit from `git log --oneline`
bash infra/deploy/update.sh                  # later: back to the newest version of main
```

Going back does **not** undo database changes: the older code runs on the newer database. That is safe when the newer migrations only added things (the usual case: new tables, columns, indexes); the script lists the migrations it is skipping and asks before going on (`--yes` skips the question). A change that removed or renamed a column needs a database restore instead (`docs/operations/backup-and-restore.md`). Keep migrations additive. Test: `bash infra/deploy/test-update.sh`.

`monitor-setup.sh` also installs a Sunday cleanup of build cache older than 3 days.

Migrations run automatically (`migrate` service) before the API starts.

**Once, when updating a server installed before migration 0032:** run `sudo bash infra/deploy/app-login.sh` after `git pull` and before the rebuild. It adds `APP_DB_PASSWORD` to `.env` and sets the password of the limited database login `tk_app`. The API and worker connect as `tk_app` (not the database owner, so a leaked API credential cannot create, drop or read tables directly); only the `migrate` job uses the owner. Without that variable compose refuses to start with "run infra/deploy/app-login.sh first". A fresh install does this in `setup.sh`.

`baseline-310.sql` (run by `setup.sh`, safe to repeat) gives tenant 310 the default reasons, attendance rules, a Mon–Fri 08:30–17:30 working week and a DRAFT consent text. Without a working week nobody is expected and phones watch no places.

## Mobile app

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/eas.json` (profile `preview`) to `https://<address>` before building.

## Firewall and backups (pilot)

`sudo bash infra/deploy/firewall.sh` (ufw: only 22, 80, 443) and `sudo bash infra/deploy/backup-setup.sh` (nightly encrypted dump of the database, uploaded files and `.env`; restore with `infra/deploy/restore.sh`). `sudo bash infra/deploy/monitor-setup.sh '<alert url>'` adds 5-minute health alerts (site, containers, disk, backup age). Step by step, with the restore test and reboot check: [`docs/operations/pilot-server-safety.md`](../../docs/operations/pilot-server-safety.md). The age private key is shown once and must be kept off the server. The scripts must stay `shellcheck`-clean.

## Point-in-time recovery of the database

`sudo bash infra/deploy/pitr-setup.sh`, then rebuild (the database container uses `postgres.Dockerfile`, with WAL archiving). Restore to any minute: [`docs/operations/pitr-docker.md`](../../docs/operations/pitr-docker.md). Without `BACKUP_AGE_RECIPIENT` in `.env` compose refuses to start with "run infra/deploy/pitr-setup.sh first".

## Not covered here

Point-in-time recovery (see `infra/backup/README.md`, needs PostgreSQL on the host, not the container), Cloudflare/WAF in front (see `docs/security/README.md`), monitoring.
Local files are kept in the Docker volumes `pgdata`, `storage`, `caddy_data`. `ATTESTATION_MODE=disabled` is for the pilot only.

## Cache rules (Caddyfile)

Fingerprinted files under `/_next/static` keep Next.js's one-year `immutable` header, `icon.svg` and the manifest get one day, `sw.js`
keeps its own no-cache rule, and every web page is sent with `Cache-Control: no-cache` (it is revalidated, a 304 when unchanged). Next.js
labels its pages `s-maxage=31536000`; a CDN in front would obey that and serve old HTML after a deploy. `/v1` (the API) is never given a
cache header here. Both Caddyfiles are checked in CI with `caddy validate`.
