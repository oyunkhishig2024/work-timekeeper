# Pilot server safety: firewall, backups, restart check

For the single DigitalOcean server that runs the pilot (`infra/deploy`). The production design with
point-in-time recovery is in [backup-and-restore.md](backup-and-restore.md); this page is the simple version
that is enough until real staff data is loaded. **Pilot backup limits: up to 24 hours of data can be lost
(one backup per night).**

Run everything on the server, as root, inside the `work-timekeeper` folder (`cd ~/work-timekeeper && git pull`).

## 1. Firewall (5 minutes)

```bash
sudo bash infra/deploy/firewall.sh
```

Only SSH (22, rate limited), HTTP (80) and HTTPS (443) stay open. It also turns on automatic security
updates. Check from your Mac that the site still opens: `https://<address>`.

Also turn on DigitalOcean's own firewall (second layer, outside the server): **Networking → Firewalls →
Create Firewall**, inbound rules **SSH 22, HTTP 80, HTTPS 443** (All IPv4, All IPv6), apply to the droplet.

## 2. Nightly encrypted backups (5 minutes)

```bash
sudo bash infra/deploy/backup-setup.sh
```

It prints a line starting `AGE-SECRET-KEY-…` **once**. Copy it into your password manager (or print it and keep
it in a safe) — **not on the server**. Without it no backup can be opened; anyone who has it can open them.

Every night 02:30 UTC the server writes `/var/backups/timekeeper/tk-<time>.tar.age` (database, uploaded files and
`.env`, all encrypted) and keeps the last 14. Check: `ls -l /var/backups/timekeeper` and
`tail /var/log/timekeeper-backup.log`.

**Copies on the same server do not survive losing the server.** Do one of:

- DigitalOcean **Droplet → Backups → Enable** (about 20% of the server price, weekly whole-server copy), and
- download a recent file now and then to your Mac: `scp root@<address>:/var/backups/timekeeper/tk-<time>.tar.age ~/Documents/`
  (they are encrypted, so storing them anywhere is safe), or set `BACKUP_REMOTE` in `/etc/timekeeper-backup.env`
  to an `rclone` remote (DigitalOcean Spaces / S3 / Backblaze) for an automatic off-server copy.

## 3. Test a restore (do this once, before real data)

On the server (this replaces the live data, so do it while only test data exists, or on a spare server):

```bash
nano /tmp/key.txt            # paste the AGE-SECRET-KEY line, save
sudo bash infra/deploy/restore.sh /var/backups/timekeeper/<newest file> /tmp/key.txt
shred -u /tmp/key.txt
```

Type `YES` when asked. Then open the admin web app: employees and the daily list must still be there.

A safer first test that never touches the live data: `bash infra/deploy/restore-test.sh <backup file> <key file>` restores a backup into a scratch database, prints row counts and removes it. It also checks that the uploaded files (signed consent scans) are in the backup: every scan the database points at must be inside it, otherwise the test fails.

If the nightly backup could save the database but not the uploaded files, `backup.sh` exits with code 3, writes `partial` to `/var/backups/timekeeper/.last-status` and `monitor.sh` sends an alert. Offline test of these scripts: `bash infra/deploy/test-backup-scripts.sh`.

## 4. Does it come back after a reboot?

```bash
sudo reboot
```

Wait 2 minutes, reconnect, run `docker ps` (postgres, api, worker, web, caddy must be `Up`) and open the site. All
containers are `restart: unless-stopped` and Docker starts at boot, so no action should be needed.

## 5. Alerts when something breaks

```bash
sudo bash infra/deploy/monitor-setup.sh 'https://ntfy.sh/<your-secret-topic>'
```

Checks the site, the containers, the disk and the newest backup every 5 minutes and messages your phone. Details, the free outside check
and the incident plan: [monitoring-and-incidents.md](monitoring-and-incidents.md).

## What this does not cover

Point-in-time recovery, and Cloudflare in front (needs your own domain: see `docs/security/cloudflare-digitalocean-caddy.md`). Do these
before the production roll-out with many employees.

## Off-server copy (Backblaze B2)

Backups on the same server do not survive losing the server. `sudo bash infra/deploy/offsite-setup.sh` sends every backup to a Backblaze B2 bucket as well. What goes there is encrypted with your public key before it leaves the server (the private key is not on the server), so the bucket only holds unreadable files.

- **Nightly archive** (`tk-<time>.tar.age`: database, uploaded files, `.env`): copied by `backup.sh` into `nightly/`. If the copy fails the local backup is kept, `backup.sh` exits with 4, `.last-status` says `offsite-failed` and the monitor alerts.
- **Point-in-time archive** (`/var/backups/timekeeper-pitr`): `offsite-sync.sh` copies new files every 10 minutes and everything nightly into `pitr/` (it only adds files, never deletes or overwrites on the remote). The monitor alerts when the last successful copy is over an hour old.
- The Backblaze key lives only in `/etc/timekeeper-backup/rclone.conf` (root, mode 600).
- Cost: only what is stored. Old files are not removed from the bucket by the scripts; in Backblaze (bucket Lifecycle Settings) you can delete files after about 60 days, which is longer than the local retention.
- Restoring from the bucket: `rclone --config /etc/timekeeper-backup/rclone.conf copy b2:BUCKET/nightly/<file> <folder>`, then `restore-test.sh` or `restore.sh` as for a local backup. Offline test of the scripts: `bash infra/deploy/test-offsite.sh`.
- Known limit: the Backblaze key created in the web page can also delete files. Anyone who gets into the server could delete the off-server copies. Tightening that (a key without the delete right, made with the `b2` command-line tool, or Object Lock) is a later step.
