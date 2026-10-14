# PostgreSQL 16 with the point-in-time-recovery tools (infra/backup): age (encryption with a public key), rclone (optional
# off-server copy), jq and the archive / base backup / restore scripts. The scripts are owned by root: the database user
# can run them but not change them.
FROM postgres:16
RUN apt-get update \
 && apt-get install -y --no-install-recommends age jq rclone \
 && rm -rf /var/lib/apt/lists/*
COPY infra/backup/bin /opt/timekeeper/infra/backup/bin
RUN chmod -R go-w /opt/timekeeper \
 && chmod 755 /opt/timekeeper/infra/backup/bin/*.sh \
 && mkdir -p /var/lib/timekeeper-backup \
 && chown postgres:postgres /var/lib/timekeeper-backup
