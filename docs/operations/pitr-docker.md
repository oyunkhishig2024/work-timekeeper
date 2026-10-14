# Point-in-time recovery of the production database (Docker)

Status: **built and rehearsed** (`infra/backup/test/docker-rehearsal.sh`). Scripts and design: `infra/backup/README.md` and
`docs/operations/backup-and-restore.md` (that manual is written for a native PostgreSQL install; this page is the Docker version
that the pilot server uses).

## What it gives

| Without it (nightly backup only)                              | With it                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Restore to last night, up to 24 hours of data lost            | Restore to **any minute** since the oldest kept base backup (7 daily + 4 weekly + 3 monthly), worst-case loss about 5 minutes |
| A wrong bulk change at 14:00 can only be undone back to 02:30 | Restore a copy to 13:59, read what was there, put it right                                                                    |

**What it does not give (yet):** the encrypted archive is on the same server (`/var/backups/timekeeper-pitr`). It protects against
mistakes and a broken database, not against losing the whole server; for that you still have the DigitalOcean daily droplet backups
(up to one day of data). A copy in another account or region is a one-line setting (`BACKUP_REMOTE=<rclone remote>`) once you choose and pay for storage.

## How it works

- The database container is built from `infra/deploy/postgres.Dockerfile` (PostgreSQL 16 + `age`, `rclone`, `jq` + the scripts).
- PostgreSQL runs with `archive_mode=on`: every finished WAL segment (at least every 4 minutes) is compressed, **encrypted with the public age key** (the same key as the nightly backup, the private key stays off the server) and written to `/var/backups/timekeeper-pitr/wal/`.
- Every night 02:50 a base backup (`pg_basebackup`, checked with `pg_verifybackup`) is encrypted and stored in `base/`. 05:30 old ones are removed.
- Every 4 minutes a tiny heartbeat makes a quiet database still close WAL segments.
- `monitor.sh` (every 5 minutes) runs `verify-backups.sh` and sends a PROBLEM message when WAL stops arriving, the base backup is older than 26 hours, a WAL segment is missing or the archiver is failing.

## Set up (on the server, about 10 minutes, the site is down for about 20 seconds)

```bash
cd ~/work-timekeeper
git pull
sudo bash infra/deploy/backup-setup.sh      # only if the nightly backup key does not exist yet
sudo bash infra/deploy/pitr-setup.sh
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml up -d --build
docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml exec -T -u postgres postgres /opt/timekeeper/infra/backup/bin/base-backup.sh
```

Check: `docker compose ... exec -T -u postgres postgres /opt/timekeeper/infra/backup/bin/verify-backups.sh` prints one line with `"status":"OK"`.
Until the first base backup exists the status is CRIT (and the monitor may send one PROBLEM message): that is expected.

## Restore a copy to a moment (safe, the live database is not touched)

You need the **age private key** (from your password manager). Copy it to the server only for this, then delete it.

```bash
cd ~/work-timekeeper
cp /path/to/private-key.txt /root/key.txt && chmod 644 /root/key.txt      # uid 999 must read it
docker run --rm -it --user postgres -v /var/backups/timekeeper-pitr:/pitr:ro -v /root/key.txt:/key.txt:ro \
  -e BACKUP_REMOTE=/pitr -e BACKUP_AGE_RECIPIENT=unused -e PGUSER=timekeeper timekeeper-postgres:16 bash
# inside the container (times in the command are UTC; Ulaanbaatar is UTC+8, so 14:00 there is 06:00+00):
/opt/timekeeper/infra/backup/bin/restore-pitr.sh --target-time "2026-10-14 06:00:00+00" --data-dir /tmp/side --port 5499 --identity /key.txt
psql -h /tmp -p 5499 -U timekeeper -d timekeeper          # look at / export what you need
exit
shred -u /root/key.txt
```

## Disaster: put the production database back to a moment

Only when the live database is lost or must be rolled back as a whole. Everything written after the target time is gone.
Take a copy of the current volume first if it still works (`docker run --rm -v deploy_pgdata:/d -v /root:/out alpine tar czf /out/pgdata-before-restore.tgz -C /d .`).

```bash
cd ~/work-timekeeper
C="docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml"
$C stop api worker web
$C stop postgres && $C rm -f postgres
docker volume rm deploy_pgdata && docker volume create --label com.docker.compose.project=deploy --label com.docker.compose.volume=pgdata deploy_pgdata
cp /path/to/private-key.txt /root/key.txt && chmod 644 /root/key.txt
docker run --rm --user postgres -v deploy_pgdata:/var/lib/postgresql/data -v /var/backups/timekeeper-pitr:/pitr:ro -v /root/key.txt:/key.txt:ro \
  -e BACKUP_REMOTE=/pitr -e BACKUP_AGE_RECIPIENT=unused -e PGUSER=timekeeper -e BACKUP_PROD_DATA_DIR=/var/lib/postgresql/data \
  timekeeper-postgres:16 bash -c '/opt/timekeeper/infra/backup/bin/restore-pitr.sh --target-time "2026-10-14 06:00:00+00" \
  --data-dir /var/lib/postgresql/data --port 5499 --identity /key.txt --force --i-am-sure --enable-archiving && pg_ctl -D /var/lib/postgresql/data stop -m fast'
shred -u /root/key.txt
$C up -d
```

Use `--latest` instead of `--target-time` to restore to the end of the archive (the whole server lost, archive intact). The restore
starts a new timeline; archiving continues. Afterwards take a base backup at once.

## Rehearse (before relying on it, after changing `infra/backup` or `postgres.Dockerfile`, and quarterly)

`infra/backup/test/docker-rehearsal.sh` (needs Docker; 3–6 minutes) builds the image, starts the database service under a throwaway project,
takes a base backup, notes a time, makes "a mistake", restores a side copy to the noted time and then destroys the volume and restores into it.
`infra/backup/test/pitr-rehearsal.sh` rehearses the native (non-Docker) variant of the same scripts.
