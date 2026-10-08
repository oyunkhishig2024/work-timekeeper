# Backup and restore runbook (PostgreSQL, single VPS)

Status: **draft for review** - applies PRD 25.2. Files: `infra/backup/` (scripts, units, test).
Proof that it works: `infra/backup/test/pitr-rehearsal.sh` (results in section 3).
Owner: Technical lead. Deputy: Account owner (see `docs/security/ddos-response-plan.md` roles).

Short messages in the scripts are English + Mongolian. Times in commands are examples (Ulaanbaatar
is UTC+8, so `09:30:00+08` is 01:30 UTC).

---

## 1. What is protected, and what is not

| Protected (inside PostgreSQL)                                                          | How                                         |
| -------------------------------------------------------------------------------------- | ------------------------------------------- |
| All tenant data, attendance events, audit log, settings, **pg-boss job queue** (ADR-2) | WAL archive (PITR) + daily base backup      |
| The same data, version-independent                                                     | weekly `pg_dump -Fc` + roles (kept 8 weeks) |
| PostgreSQL server config (`/etc/postgresql/16/main`)                                   | copied into every base backup               |

| NOT protected by this solution - needs its own plan                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Object storage** (consent scans, generated exports, consent PDFs - Architecture components table). Needs bucket versioning plus replication/backup in the second account.                                                                                                                                                                                       |
| **Secrets**: `JWT_SECRET`, `DATA_ENCRYPTION_KEY`, database passwords, Cloudflare tunnel credentials, the age private key, rclone keys. They are not in the database. **If `DATA_ENCRYPTION_KEY` is lost, field-encrypted columns (TOTP secrets, consent object keys) are unreadable even with a perfect restore.** Keep them in the password manager, two copies. |
| Application code (git), nginx/Cloudflare/firewall files (git: `infra/`), OS packages                                                                                                                                                                                                                                                                              | rebuilt from git; list in runbook C     |
| Data on employees' phones (offline queue)                                                                                                                                                                                                                                                                                                                         | phones re-send; see limits in section 9 |
| Anything an attacker with root on the VPS does: the VPS holds the backup _upload_ credentials                                                                                                                                                                                                                                                                     | see "hardened mode" in section 4        |

## 2. Architecture

```
 Hostinger VPS (Ubuntu, PostgreSQL 16)                          Off-site (other account + region)
 ┌──────────────────────────────────────────────┐            ┌────────────────────────────────────┐
 │ PostgreSQL ──WAL segment closed (16 MB, or   │            │ b2:/r2:/s3: bucket  (rclone remote)│
 │   │          every 240 s via archive_timeout)│            │   wal/   <seg>.gz.age  <seg>.sha256│
 │   ▼                                          │   rclone   │   base/  base-<UTC>.tar.age  + .json│
 │ wal-archive.sh: gzip → age(public key)       │ ─────────▶ │   logical/ dump-*.dump.age         │
 │   → temp file → fsync → rename → spool/      │   HTTPS    └────────────────────────────────────┘
 │   → upload (temp+rename) → delete from spool │                         ▲
 │   (remote down? stays in spool/, bounded)    │                         │ read-only key
 │ timers: base-backup 02:30 · verify /10 min   │                ┌────────┴──────────────┐
 │   · logical Sun 03:30 · retention 05:30      │                │ Restore / verify host │
 │   · wal-heartbeat /4 min                     │                │ (new VPS or staging)  │
 │ holds: age PUBLIC key + upload credentials   │                │ holds age PRIVATE key │
 └──────────────────────────────────────────────┘                │ only while restoring  │
        age PRIVATE key: 2 offline copies (section 5)            └───────────────────────┘
```

- **WAL** gives point-in-time recovery to any moment since the oldest retained base backup.
- **Base backup** (`pg_basebackup`, gzip, SHA-256 manifest, WAL included) is verified with
  `pg_verifybackup` _before_ it is uploaded and before its catalog JSON makes it exist.
- **Retention:** newest base of each of the last 7 days, 4 ISO weeks and 3 months (UTC), always the
  newest verified base; WAL older than the oldest kept base is deleted. About 3 months of PITR depth
  at the monthly end, 7 days at daily granularity.
- **Logical dump** is the second layer: restores into a different PostgreSQL major version and lets you
  recover one database without WAL replay.

## 3. RPO and RTO

### RPO (PRD: <= 15 minutes)

| Component                                                       | Worst case                                                                                                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archive_timeout = 240` (+ heartbeat keeps a quiet DB "active") | a transaction is in an open segment for <= 240 s                                                                                                                                                                       |
| compress + encrypt + upload of one segment                      | seconds (rclone retry budget: ~1-3 min)                                                                                                                                                                                |
| **Typical worst case**                                          | **about 5 minutes**                                                                                                                                                                                                    |
| Remote outage: WAL waits in the local spool                     | still on the VPS disk only: **a VPS loss during an outage loses everything in the spool.** The 10-minute check turns WARN after 10 min and CRIT after 15 min (= the RPO), so the PRD target is _monitored_, not magic. |

Not provided: **synchronous replication** (zero data loss). A single VPS has no standby. Work done in
the last <= 5 minutes before a disk loss is lost; the app's offline queue (PRD 6.8) covers events that
were never acknowledged, but see section 9 for acknowledged ones.

### RTO (PRD pilot: <= 8 hours)

Measured by `pitr-rehearsal.sh` on this build machine (tiny database, local "remote", so this is the
**fixed overhead** of the scripts: download, checksum, decrypt, unpack, server start, WAL fetch/replay of 13 segments):

| Rehearsal step                                       | Duration   |
| ---------------------------------------------------- | ---------- |
| Restore 1: PITR to an exact time (base + WAL replay) | 2.5 s      |
| Restore 2: `--latest` (end of archive)               | 3.8 s      |
| Restore 3: side instance before a `DROP TABLE`       | 2.3 s      |
| Rehearsal total, 126 assertions                      | about 70 s |

Production estimate (replace the inputs with the numbers from your first real base backup, the
catalog JSON has `size_bytes`; **re-measure every quarter**):

```
RTO ~= T_server  + T_setup  + S_enc / B  + S / U  + W_comp / B  + W_raw / R  + T_checks + T_traffic
        new VPS     packages   download    unpack     fetch WAL      WAL replay    smoke tests  tunnel/DNS
S      database size on disk        S_enc  encrypted base size (~0.3-0.5 x S, measure it)
B      download speed, MB/s          U      decompress + write, ~100 MB/s
W_raw  WAL since the chosen base (<= 24 h, or a month if restoring the oldest)   W_comp ~ 0.2 x W_raw
R      WAL replay speed, ~20-50 MB/s (measure it)
Example: S = 50 GB, S_enc = 20 GB, B = 25 MB/s (200 Mbit/s), W_raw = 3 GB:
  T_server 60 min + T_setup 30 + 20 GB/25 = 14 min + 50 GB/100 = 8 min + 0.6 GB/25 = 1 min
  + 3 GB/30 = 2 min + T_checks 30 + T_traffic 15  ~=  2 h 40 min     (limit 8 h)
```

The pilot database is expected to be small (about 2 million event rows a year), so **the human steps
(provisioning, access, decisions) dominate, not the data**. Hence the checklists below and the
quarterly rehearsal on a _fresh_ machine. RTO is **hours, not minutes**: the service is down for the
whole procedure; there is no hot standby.

## 4. Off-site storage

The scripts use `rclone`, so any S3-compatible store works. Options (all with object versioning/lock):

| Provider                 | Notes                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Backblaze B2             | cheap; app keys can be limited to write/list without delete; Object Lock; egress free up to a multiple of stored data |
| Cloudflare R2            | no egress fee; same Cloudflare account as the CDN is a _shared failure/compromise domain_: use a separate account     |
| Wasabi                   | flat price; **minimum storage period of 90 days per object** (WAL deleted earlier is still billed)                    |
| Any S3 / MinIO elsewhere | works the same                                                                                                        |

**Legal gate (do before go-live):** the backups contain employees' **personal data** (names, employee
codes, attendance, location-derived events; PRD 15.3). Hosting is abroad (Singapore) and PRD 15.3/25.2
require the backup copy in a **second foreign region or a separate account**. Each backup provider is
a _processor_: it must be listed in the foreign processors register, covered by a data processing
agreement, and **cleared with legal counsel** (cross-border transfer, consent wording, Appendix A item 7)
before the first production backup leaves the VPS. Encryption with a key the provider never sees
reduces the exposure, but does not remove the legal requirement. Pick a region different from the
VPS and a **different account** (different login, different payment owner, MFA on).

Setup: create a private bucket, enable versioning/Object Lock (30 days), and an app key restricted to that bucket.

- **Simple mode (pilot):** the VPS key may write, list and delete (retention runs on the VPS).
- **Hardened mode (recommended before the production tier):** the VPS key can only write and list (no
  delete). Run `retention.sh` and `verify-backups.sh --deep` from a _second host_ (the staging VPS) with
  a delete-capable key, and disable `timekeeper-backup-retention.timer` on the database server. Then an
  attacker who owns the VPS cannot erase the backups.

## 5. Encryption key management

- Tool: **age**. The VPS has only the **public** key (`BACKUP_AGE_RECIPIENT`); it can encrypt, never decrypt.
- Create the key pair **on a trusted workstation, not on the server**: `age-keygen -o timekeeper-backup.key`
  (the file contains the private key and, as a comment, the public key `age1...`; `age-keygen -y FILE` prints it).
- **Two offline copies, in two places**, e.g. (1) password manager attachment of the Account owner +
  (2) printed/USB in the company safe or with the Technical lead. Neither copy lives on the VPS, the
  bucket, the repo or in chat. Test that **both** copies decrypt something at every quarterly rehearsal.
- Optional extra safety: list two recipients in `BACKUP_AGE_RECIPIENTS_FILE` (one key per person/office,
  one line each). Either private key can decrypt.
- **If every copy of the private key is lost, every backup is unreadable. There is no recovery.** The
  procedure is then: generate a new key pair, change the public key on the VPS, take a new base backup
  immediately (old ones are useless), and treat the period as unprotected.
- **Rotation** (yearly, or on suspicion of leak, or when a key holder leaves): generate a new pair, put
  both public keys in the recipients file (`new` + `old`), run a base backup, wait until older bases are
  retired by retention (3 months) _or_ re-encrypt them: `age -d -i old.key < f | age -r NEWPUB > f2`
  (do it on the restore host). Keep the old private key until the last file encrypted to it has expired.
  Leak of the **public** key is harmless. Leak of the **private** key: rotate immediately and treat the
  old backups as exposed (breach procedure, PRD 15.3).

## 6. Setup on the VPS (first time, then repeat on the staging host)

```bash
# 1. packages (Ubuntu 22.04/24.04)
sudo apt install -y postgresql-16 age rclone jq curl util-linux
# 2. code: scripts must be root-owned and not writable by postgres
sudo mkdir -p /opt/timekeeper && sudo git clone <repo> /opt/timekeeper    # or copy infra/backup
sudo chown -R root:root /opt/timekeeper && sudo chmod -R go-w /opt/timekeeper
# 3. rclone remote for the postgres user (keep the key out of the repo)
sudo install -d -o root -g postgres -m 750 /etc/timekeeper-backup
sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf config      # create remote "b2" / "r2" / "s3"
sudo chown postgres:postgres /etc/timekeeper-backup/rclone.conf && sudo chmod 600 /etc/timekeeper-backup/rclone.conf
sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf lsd b2:   # must list the bucket
# 4. env file (no secrets except the webhook URL)
sudo install -o root -g postgres -m 640 /dev/null /etc/timekeeper-backup.env
sudoedit /etc/timekeeper-backup.env     # content: infra/backup/README.md
# 5. state directory
sudo install -d -o postgres -g postgres -m 700 /var/lib/timekeeper-backup
# 6. PostgreSQL settings, then ONE restart (wal_level/archive_mode)
sudo cp /opt/timekeeper/infra/backup/postgresql-backup.conf /etc/postgresql/16/main/conf.d/90-timekeeper-backup.conf
sudo systemctl restart postgresql@16-main
sudo -u postgres psql -c "show archive_mode" -c "show archive_command" -c "show data_checksums"
#    data_checksums must be "on" (new cluster: initdb --data-checksums; existing: pg_checksums --enable, offline)
# 7. prove archiving works before enabling timers
sudo -u postgres psql -c "select pg_switch_wal()"; sleep 10
sudo -u postgres psql -c "select archived_count, failed_count, last_archived_wal from pg_stat_archiver"
sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf lsf b2:BUCKET/pg/wal | tail -3     # *.gz.age files
# 8. first base backup + checks
sudo -u postgres /opt/timekeeper/infra/backup/bin/base-backup.sh
sudo -u postgres /opt/timekeeper/infra/backup/bin/verify-backups.sh      # expect {"status":"OK",...}
# 9. timers
sudo cp /opt/timekeeper/infra/backup/systemd/* /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now timekeeper-base-backup.timer timekeeper-backup-verify.timer \
     timekeeper-wal-heartbeat.timer timekeeper-logical-dump.timer timekeeper-backup-retention.timer \
     timekeeper-backup-deep-verify.timer
systemctl list-timers 'timekeeper-*'
# 10. GO-LIVE GATE: a full restore on another machine (runbook A or D) and a recorded result in D.3
```

Notes: with Debian/Ubuntu the `postgres` user must be allowed `local replication` in `pg_hba.conf`
(default does). The age private key is **not** needed on the VPS; without it the 10-minute check
validates the age header and checksums only; with it set on the _staging_ host, `--deep` does full
decrypt + `pg_verifybackup`. Run the rehearsal script (`infra/backup/test/pitr-rehearsal.sh`) after
every change to these scripts.

## 7. Monitoring and alerts

`verify-backups.sh` (every 10 min, user `postgres`) prints one JSON line (`journalctl -u
timekeeper-backup-verify -n 1`), exit 0/1/2. Non-zero exit marks the unit failed; `OnFailure=`
runs `alert.sh` (syslog + `BACKUP_ALERT_WEBHOOK`, same message at most once per hour). PRD 25.1 lists
"backup failure" as a **paged** alert; connect the webhook to the paging channel.

| Check           | WARN                                         | CRIT (page)                                                          | Likely cause / first action                            |
| --------------- | -------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ |
| `remote`        | -                                            | remote unreachable                                                   | credentials, bucket, network; run runbook E step 2     |
| `base_age`      | -                                            | newest base older than 26 h or none                                  | `journalctl -u timekeeper-base-backup`; run it by hand |
| `base_verified` | -                                            | newest base not verified                                             | re-run base backup                                     |
| `wal_age`       | newest WAL older than 2 x 240 + 120 = 600 s  | older than 900 s (the RPO)                                           | archiver failing, DB down, remote down                 |
| `wal_gaps`      | segments missing only before the newest base | segment missing after the newest base: **PITR broken**               | take a new base backup NOW; runbook E                  |
| `spool`         | >= 256 MB queued                             | >= 2048 MB (full), or a conflict file parked                         | remote outage; runbook E                               |
| `newest_file`   | -                                            | not age-encrypted / does not decrypt / bad checksum                  | stop, investigate (tampering or config error)          |
| `archiver`      | cannot query                                 | `pg_stat_archiver` currently failing                                 | runbook E                                              |
| `deep`          | -                                            | last deep check failed (hash mismatch, bad decrypt, pg_verifybackup) | treat the newest base as bad; take another             |

Who: WARN goes to the Technical lead in working hours (next business morning if at night); CRIT pages the
Technical lead at once and, after 30 min without acknowledgement, the Account owner. Also watch **disk
usage on the VPS** (`df`): alert at 80 % (outside this solution, add to the host monitoring).
Self-monitoring gap: if the VPS or its timers are dead, nothing sends an alert. Add an external check
(e.g. a free uptime monitor that fails when the webhook "heartbeat" is missing, or run `verify-backups.sh`
from the staging host too - it needs only the read-only bucket key).

## 8. Runbooks

### A. Disaster: restore to a point in time on a NEW server

When: the VPS or its disk is lost/corrupted, or the database is damaged beyond repair. Declare it as
SEV 1 (`docs/security/ddos-response-plan.md` roles). **Make sure the old server is switched off** before the
new one archives (two servers writing the same archive prefix cause conflicts, exit 12, on purpose).

1. **Decide the target.** Latest possible: `--latest`. Corruption/mistake at a known time: a time just
   before it, with timezone: `"2026-10-08 09:30:00+08"`. Write the decision and the time in the incident log.
2. **Get the people and secrets:** age private key (offline copy), read-only bucket key, repo access,
   the secrets list from section 1 (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, ...).
3. **New server** (same Ubuntu release, same data-center rules as `infra/hostinger`), then:
   ```bash
   sudo apt install -y postgresql-16 age rclone jq curl util-linux git
   sudo git clone <repo> /opt/timekeeper && sudo chown -R root:root /opt/timekeeper
   sudo install -d -m 750 -o root -g postgres /etc/timekeeper-backup
   sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf config      # same remote name as before
   sudoedit /etc/timekeeper-backup.env        # BACKUP_REMOTE=..., RCLONE_CONFIG=..., BACKUP_AGE_RECIPIENT=<same public key>
   sudo install -m 600 /dev/null /root/age.key && sudoedit /root/age.key    # paste the PRIVATE key; delete it afterwards
   ```
4. **See what is available:**
   ```bash
   sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf lsf b2:BUCKET/pg/base | grep json
   sudo -u postgres rclone --config /etc/timekeeper-backup/rclone.conf cat b2:BUCKET/pg/base/base-<label>.json | jq .
   ```
5. **Restore** (stop and wipe the default cluster; the script refuses the production directory without `--i-am-sure`):
   ```bash
   sudo systemctl stop postgresql@16-main
   # use --latest instead of --target-time "..." to recover to the end of the archive
   sudo /opt/timekeeper/infra/backup/bin/restore-pitr.sh \
        --target-time "2026-10-08 09:30:00+08" \
        --base auto --identity /root/age.key \
        --data-dir /var/lib/postgresql/16/main --port 5432 --socket-dir /var/run/postgresql \
        --force --i-am-sure
   ```
   The script checks the catalog and checksum, decrypts, unpacks, writes `recovery.signal` and `restore_command`,
   starts PostgreSQL on that port, replays WAL to the target and promotes. It prints `RESTORE COMPLETE` and the
   duration. If it fails with "target beyond the archive" pick an earlier time or `--latest`; if with
   "decrypt failed" the key is wrong. Log: `/var/lib/postgresql/16/main/restore-postgres.log`.
6. **Hand over to systemd with the production config:**
   ```bash
   sudo -u postgres /usr/lib/postgresql/16/bin/pg_ctl -D /var/lib/postgresql/16/main stop
   sudo cp /var/lib/postgresql/16/main.config-from-backup/*.conf /etc/postgresql/16/main/   # review: paths, listen_addresses, archive_command
   sudo cp /opt/timekeeper/infra/backup/postgresql-backup.conf /etc/postgresql/16/main/conf.d/90-timekeeper-backup.conf
   sudo systemctl start postgresql@16-main
   ```
   If the new cluster must archive into the **same bucket prefix**, it continues on a new timeline (names start
   `00000002...`), which is normal. If the system was rebuilt with a fresh `initdb` instead of a restore, use a **new prefix**.
7. **Verify the data:** `sudo -u postgres psql -d timekeeper -c "select max(created_at) from audit_log"` (compare
   with the incident time: this is your actual RPO), row counts of the main tables, `pg_amcheck -d timekeeper`,
   `vacuumdb --all --analyze-in-stages`. Restore secrets, deploy the API and worker from the release tag
   (migrations are already applied), run the smoke tests.
8. **Anchor the new chain immediately:** `sudo -u postgres /opt/timekeeper/infra/backup/bin/base-backup.sh`,
   install the units (section 6 steps 9), run `verify-backups.sh`. `shred -u /root/age.key`.
9. **Switch traffic:** runbook C step 8. Tell HR about the lost window (section 9).
10. **Record** actual RPO and RTO in the incident log and in the table in D.3.

### B. Logical mistake: someone deleted or overwrote data

Do **not** restore over production. Restore to a **side instance** at a time before the mistake, take the
rows you need, put them back.

1. Find the time: audit log, app logs, or ask the person. Choose a time a few minutes **before**. Check disk:
   the side instance needs about the size of the database (`df -h`); otherwise do it on the staging host.
2. Restore (promote mode; `--pause` is not suitable when the mistake itself touched the table:
   a replayed `DROP/ALTER` already holds its lock on a paused standby and queries on that table hang):
   ```bash
   sudo /opt/timekeeper/infra/backup/bin/restore-pitr.sh --target-time "2026-10-08 09:30:00+08" \
        --identity /root/age.key --data-dir /var/lib/timekeeper-side --port 5433 --socket-dir /tmp
   ```
   Port 5433, archiving **off** (default), listens on localhost only. It never writes to the real archive.
3. Extract:
   ```bash
   # whole table, with structure
   sudo -u postgres pg_dump -h /tmp -p 5433 -d timekeeper -t public.<table> -Fc -f /tmp/<table>.dump
   # or only some rows as CSV
   sudo -u postgres psql -h /tmp -p 5433 -d timekeeper -c "\copy (select * from <table> where tenant_id='...' and deleted_at is null) to '/tmp/rows.csv' csv header"
   ```
   Row-level security: connect as the owner/superuser (`postgres`) for extraction **and** for the re-import;
   the application role is filtered by `tenant_id` (see `apps/api/db/migrations/README.md`).
4. Re-import into production **carefully, in a transaction, into a staging table first**:
   ```bash
   sudo -u postgres psql -d timekeeper -c "create table restored_<table> (like <table> including all)"
   sudo -u postgres psql -d timekeeper -c "\copy restored_<table> from '/tmp/rows.csv' csv header"
   # review, compare, then:  begin; insert into <table> select * from restored_<table> on conflict (id) do nothing; commit;
   ```
   Check foreign keys and **closed periods** (PRD 25.5: reopen the month with the audited approval before importing),
   and **recompute** derived attendance results for the affected days. Make the change auditable (note the incident id).
5. **Clean up the side instance** - it holds a full copy of personal data:
   `sudo -u postgres pg_ctl -D /var/lib/timekeeper-side stop; sudo rm -rf /var/lib/timekeeper-side* /tmp/*.csv /tmp/*.dump; sudo shred -u /root/age.key`.

Proven by the rehearsal (restore 3): table dropped, side instance at the earlier time, `pg_dump -t`, re-import: 50 of 50 rows back.

### C. The whole VPS is lost (rebuild checklist)

1. SEV 1; follow `docs/security/ddos-response-plan.md` communication (templates A/B). Switch the admin host to the static
   status page; leave `api` returning errors so phones keep their queue (plan step 4.1).
2. New VPS (another data center if possible - the standby idea of plan step 4.2) and **a new IP**. If the old IP
   leaked, never reuse it (plan step 4.3).
3. Harden: `infra/hostinger/allow-cloudflare-only.sh`, SSH keys only, automatic security updates.
4. Packages and config from git: nginx (`infra/nginx`), Node/pnpm for API and worker, `cloudflared` (tunnel
   credentials from the password manager), Cloudflare rules (`infra/cloudflare/apply.sh`).
5. Secrets from the password manager into the service environment (`JWT_SECRET`, `DATA_ENCRYPTION_KEY`, DB, rclone).
6. **Database: runbook A** steps 3-8.
7. Deploy API and worker at the last release tag; start; smoke test (login, a device event, report export).
8. **Repoint traffic** exactly as in `docs/security/ddos-response-plan.md` **step 4.2** (move the origin: point the tunnel /
   proxied DNS record of `api` and `admin` to the new server; effective in about a minute through Cloudflare),
   then step 4.3 for the old address. Restore the normal rules one at a time (plan step 5.1).
9. Expect the **wave of delayed phone events** (plan step 5.2) and tell HR to re-check absences for the incident window
   (plan step 5.3). Check `object storage` is reachable from the new server.
10. Re-enable backups on the new server (A.8), send template C, close the incident, add lessons to the rehearsal log.

### D. Quarterly restore rehearsal (PRD 25.2: before go-live, then every quarter)

Do it on a **different machine** than production (the staging VPS), as if production were gone.

D.1 Checklist

- [ ] Run `infra/backup/test/pitr-rehearsal.sh` on the checkout of the current release: all assertions pass (script logic still works).
- [ ] Fetch the age private key from copy 1 (next quarter: copy 2) - proves the key is usable.
- [ ] `verify-backups.sh --deep` with the identity: status OK (full decrypt + `pg_verifybackup` of the newest base).
- [ ] Pick a target time T about 1 hour ago. On production note: `select count(*) from audit_log where created_at <= 'T'` and counts of 3 key tables.
- [ ] Run `restore-pitr.sh --target-time T ...` on the staging host with a stopwatch (include provisioning if from scratch). Record the time.
- [ ] Compare the same counts on the restored instance (they must match; the audit rows after T must be absent).
- [ ] Application smoke test against the restored instance (staging API pointing to it; no production data is left on staging afterwards: delete it).
- [ ] Restore the newest **logical dump** once per quarter into a scratch database (`pg_restore -d scratch`).
- [ ] Compute RTO estimate with the formula in section 3 using the real base size; update section 3 if it changed materially.
- [ ] Delete the restored data and the key copy from the staging host; fill in D.3; file it with the quarter's records.

D.3 Result log (copy a row each time)

| Date      | By  | Release | Base used (label, size) | Target T | Restore duration (hh:mm:ss) | Counts prod = restored? | Deep verify | Key copy used | RPO observed | Est. RTO for prod size | Problems / actions | Signed |
| --------- | --- | ------- | ----------------------- | -------- | --------------------------- | ----------------------- | ----------- | ------------- | ------------ | ---------------------- | ------------------ | ------ |
| _go-live_ |     |         |                         |          |                             |                         |             |               |              |                        |                    |        |
| _Q1_      |     |         |                         |          |                             |                         |             |               |              |                        |                    |        |

### E. WAL archiving fails (the disk can fill up)

Why it matters: PostgreSQL keeps every WAL segment it could not archive. `pg_wal` grows until the disk is full and
**PostgreSQL then stops** (the data is safe; the service is down). Treat this as urgent. Never delete files in `pg_wal` by hand.

1. **Look:** `df -h /var/lib/postgresql`; `du -sh /var/lib/postgresql/16/main/pg_wal`;
   `sudo -u postgres psql -c "select failed_count, last_failed_wal, last_failed_time, last_archived_time from pg_stat_archiver"`;
   `journalctl -t timekeeper-backup -n 50`; `du -sh /var/lib/timekeeper-backup/spool`.
2. **Reproduce by hand** with a pending segment to see the exit code:
   `sudo -u postgres env TK_BACKUP_ENV=/etc/timekeeper-backup.env /opt/timekeeper/infra/backup/bin/wal-archive.sh pg_wal/<segment> <segment>`
   (run from `/var/lib/postgresql/16/main`).
   | Exit                     | Meaning                                                                                                                        | Fix                                                                                          |
   | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
   | 0 with "queued" warnings | remote unreachable, spool absorbing WAL                                                                                        | fix credentials/network/quota/bucket (`rclone lsd`); spool drains by itself on the next call |
   | 13                       | spool full                                                                                                                     | fix the remote **now**; raise `BACKUP_SPOOL_MAX_MB` only if disk allows                      |
   | 14                       | remote down, spooling disabled                                                                                                 | fix the remote                                                                               |
   | 12                       | a **different** file with this name exists (second server writing the same prefix? restored timeline? re-initialised cluster?) | find out why; do **not** delete the remote file blindly. Rebuilt cluster = use a new prefix  |
   | 10                       | configuration (key, env file, rclone missing)                                                                                  | fix `/etc/timekeeper-backup.env`                                                             |
   | 11                       | local disk/permissions/encryption                                                                                              | fix the spool directory, disk space                                                          |
3. **If the disk is > 85 % and the cause will take long:** (a) grow the disk or attach a volume and move/extend the spool
   (`BACKUP_SPOOL_DIR`); (b) free space that is not `pg_wal` (old logs, `apt clean`, journal vacuum); (c) as a last resort point
   `archive_command` temporarily to a **local directory on another disk** (`'test ! -f /mnt/x/%f && cp %p /mnt/x/%f'`, reload) so
   PostgreSQL can recycle `pg_wal`, and copy those files into the archive later. **Do not** set `archive_command = '/bin/true'`
   or `archive_mode = off`: that silently breaks the PITR chain.
4. After a real gap (a segment lost, or `wal_gaps` CRIT): **take a new base backup immediately**
   (`systemctl start timekeeper-base-backup`). PITR across the gap is impossible; PITR after the new base works. Record the
   window in the incident log.
5. If PostgreSQL already stopped because the disk is full: free space (step 3), start it, let it archive, check `pg_stat_archiver`.
6. Never create replication slots nobody monitors: they also retain WAL without limit.

### F. Major-version upgrade (16 to 17) and other things that change the backup

- Physical backups and WAL are tied to the **major version and the cluster identity**. A PG16 base backup cannot restore
  to PG17. Upgrade plan: keep the PG16 backups and the PG16 binaries until the retention window (3 months) is over, so an old
  base can still be restored if needed.
- **Use a new bucket prefix per major version/new cluster** (e.g. `b2:BUCKET/pg17`). A new or `pg_upgrade`d cluster starts again at
  `000000010000000000000001`; sending that into the PG16 prefix would collide, and `wal-archive.sh` will (correctly) refuse with exit 12.
- Right after the upgrade: update `BACKUP_PG_BIN`, the `postgresql-backup.conf` path, run `base-backup.sh`, then
  `verify-backups.sh --deep` and a full rehearsal (D) **on the new version before** removing the old cluster.
- The weekly **logical dump** is the bridge: a PG16 dump restores into PG17 (`pg_restore` of the new version).
- Same procedure when you `initdb` a fresh cluster for any reason.
- Changing `wal_segment_size` or tablespaces: set `BACKUP_WAL_SEG_MB`; tablespaces are not restored by `restore-pitr.sh`
  (it warns) - the Timekeeper schema uses none.

## 9. Honest limits

- **One VPS, no standby.** Hardware or provider failure means hours of downtime (RTO is hours), not seconds. A warm standby
  server and replication belong to the production tier (PRD 25.2) and are not built here.
- **No synchronous replication:** transactions of the last few minutes before a disk loss are lost (RPO: about 5 min
  typical, up to 15 min by target, longer if the remote is down and the VPS then dies).
- **Acknowledged events in the lost window:** phones mark an event as delivered when the server acknowledges it. Events
  acknowledged inside the lost window will not come back by themselves. **Open item for the app/API design:** keep delivered
  events on the phone for a short period (for example 24 h) and let the server ask devices for a re-sync from a timestamp;
  until then HR reviews the window manually (as in runbook C step 9).
- Backups protect against loss, not against bad data replicated into them: a logical mistake needs runbook B.
- Backups are only as good as the last **tested** restore: the quarterly rehearsal (D) is part of the system.
- A root-level attacker on the VPS can use the upload credentials; use hardened mode (section 4).
- The rehearsal script proves the logic with a local directory as the remote. It uses a stand-in for `rclone`, so the first real
  run against B2/R2 (setup step 7 and the go-live restore) is what proves the provider integration.
