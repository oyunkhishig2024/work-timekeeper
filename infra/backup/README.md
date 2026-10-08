# infra/backup - PostgreSQL backup and point-in-time recovery

Backup of the Timekeeper PostgreSQL 16 database on the single self-managed VPS: continuous
WAL archiving + daily base backups + weekly logical dump, all **encrypted before they leave the
server** and shipped to storage in another account/region. Meets PRD 25.2 (RPO <= 15 min,
RTO <= 8 h, restore tested before go-live and quarterly). The full operator manual is
[`docs/operations/backup-and-restore.md`](../../docs/operations/backup-and-restore.md).

| Path                         | What                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `postgresql-backup.conf`     | `wal_level`, `archive_mode`, `archive_command`, `archive_timeout`, `wal_compression`      |
| `bin/wal-archive.sh`         | `archive_command` target: gzip, age-encrypt, fsync, atomic rename, spool, upload          |
| `bin/wal-fetch.sh`           | `restore_command` target (fetch, decrypt, verify checksum)                                |
| `bin/wal-heartbeat.sh`       | tiny WAL record every 4 min so `archive_timeout` also works on a quiet database           |
| `bin/base-backup.sh`         | daily `pg_basebackup`, `pg_verifybackup`, encrypt, upload, catalog JSON, retention        |
| `bin/retention.sh`           | 7 daily + 4 weekly + 3 monthly bases; deletes WAL older than the oldest kept base         |
| `bin/restore-pitr.sh`        | restore to a time (`--target-time`) or the end of the archive (`--latest`)                |
| `bin/verify-backups.sh`      | monitoring check, one JSON line, exit 0/1/2 (OK/WARN/CRIT); `--deep` for the heavy checks |
| `bin/logical-dump.sh`        | weekly `pg_dump -Fc` + roles, encrypted, keep 8                                           |
| `bin/alert.sh`, `bin/lib.sh` | webhook/syslog alert (rate limited); shared functions                                     |
| `systemd/`                   | services and timers (copy to `/etc/systemd/system/`)                                      |
| `test/pitr-rehearsal.sh`     | automated end-to-end proof on a throwaway cluster (no network needed)                     |

## Design decisions

- **Encryption: `age`** (public-key). The server holds only the _public_ key, so a stolen server,
  bucket or provider account cannot decrypt backups; the private key lives offline. `openssl enc
-aes-256-cbc -pbkdf2` needs the secret key on the server and has no integrity protection.
- **Remote:** `BACKUP_REMOTE` is an `rclone` remote (`b2:bucket/prefix`, `r2:...`, `s3:...`) or a plain
  absolute directory (tests, NFS). Layout: `wal/`, `base/`, `logical/`.
- **Spool:** if the remote is down, WAL stays in `/var/lib/timekeeper-backup/spool` (bounded,
  alerts at `BACKUP_SPOOL_WARN_MB`, blocks at `BACKUP_SPOOL_MAX_MB`) and is uploaded by the next call.
- **Catalog JSON** (`base/base-<label>.json`) is uploaded last and is what makes a base backup exist.
- Nothing is ever overwritten: a different file with an existing name is a conflict (exit 12).

## Configuration: `/etc/timekeeper-backup.env` (mode 0640, owner root, group postgres)

```
BACKUP_REMOTE=b2:timekeeper-backup-prod/pg          # or /mnt/offsite/pg
BACKUP_AGE_RECIPIENT=age1...                          # PUBLIC key (or BACKUP_AGE_RECIPIENTS_FILE=/etc/timekeeper-backup/recipients.txt)
RCLONE_CONFIG=/etc/timekeeper-backup/rclone.conf      # holds the bucket key; 0600 postgres
BACKUP_DUMP_DBS=timekeeper                            # databases for the weekly logical dump
BACKUP_PG_CONF_DIR=/etc/postgresql/16/main            # saved inside each base backup
BACKUP_ALERT_WEBHOOK=https://...                      # secret URL; optional
# optional, defaults in brackets
# BACKUP_ARCHIVE_TIMEOUT_S=240  BACKUP_WAL_MARGIN_S=120  BACKUP_RPO_S=900  BACKUP_MAX_BASE_AGE_H=26
# BACKUP_SPOOL_WARN_MB=256  BACKUP_SPOOL_MAX_MB=2048 (0 = no spool)  BACKUP_LOGICAL_KEEP=8
# BACKUP_KEEP_DAILY=7  BACKUP_KEEP_WEEKLY=4  BACKUP_KEEP_MONTHLY=3  BACKUP_PG_BIN=/usr/lib/postgresql/16/bin
# BACKUP_AGE_IDENTITY=/path/to/private.key   # ONLY on a verification/restore host, never on the database server
```

The env file must **not** contain the age private key. `TK_BACKUP_ENV=/path` selects another env file.

## Exit codes (wal-archive.sh, shared by the other scripts where it applies)

`0` ok - `10` configuration/usage - `11` local failure - `12` conflict (different file already exists,
not overwritten) - `13` spool full - `14` remote down and spooling disabled - `20` base backup ok but
retention failed - `75` already running. `restore_command` uses `1` = not in archive, `127` = hard failure.

## Prove it works

```
infra/backup/test/pitr-rehearsal.sh       # ~1-2 minutes; needs initdb/pg_ctl 16, age, jq; run as root or as a user that may run initdb
```

It builds a throwaway cluster on port 5544 in a temp directory, destroys its data directory, restores
to an exact time and to the end of the archive, and exits non-zero if any assertion fails. It never
touches another PostgreSQL on the machine. Run it before go-live, after any change to these scripts and
with each quarterly rehearsal. `shellcheck infra/backup/bin/*.sh infra/backup/test/*.sh` should be clean.
