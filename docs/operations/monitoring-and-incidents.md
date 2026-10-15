# Monitoring and incident plan (pilot)

## 1. Monitoring (15 minutes)

Two checks, because a server that is completely down cannot report itself.

**a) From the server (`infra/deploy/monitor.sh`, every 5 minutes).** Checks the site over HTTPS, the 5 containers, disk space, memory, swap and CPU load (limits `MONITOR_MEM_FREE_PERCENT` 10, `MONITOR_SWAP_PERCENT` 60, `MONITOR_LOAD_PER_CORE` 1.5), a container stopped for lack of memory, and the age of the
newest backup. It sends a message when something turns bad, a reminder every 6 hours, and a message when it recovers.

1. Choose where messages go. Simplest: the free **ntfy** app (Android/iOS). Install it, subscribe to a topic with a long random name,
   e.g. `timekeeper-7f3k9x2m-alerts` (anyone who knows the name can read the alerts, so make it hard to guess). The address is `https://ntfy.sh/<topic>`.
   (Telegram, Slack or Discord webhooks also work: any URL that accepts a plain text POST.)
2. On the server: `cd ~/work-timekeeper && git pull && sudo bash infra/deploy/monitor-setup.sh 'https://ntfy.sh/<topic>'`.
3. Test the address: `curl -d 'test' 'https://ntfy.sh/<topic>'` must show up on your phone.
4. Test the check: `docker compose --env-file infra/deploy/.env -f infra/deploy/docker-compose.yml stop worker`, wait 5 minutes: you get «PROBLEM: container worker is not running». Start it again: «RECOVERED».

**b) From outside (free).** Create an account at an uptime service (for example UptimeRobot), add an HTTPS monitor on `https://<domain>/v1/health`
every 5 minutes with email/SMS to you and your partner. This one also tells you when the whole server or its network is down.

The API additionally warns Org Admins in the web app (push) about suspicious sign-ins and devices; keep push on for the admin accounts.

## 2. Incident plan (one page; fill in the names)

**Roles:** Incident lead: [name, phone]. Backup: [name, phone]. Lawyer: [name, phone]. Hosting support: DigitalOcean ticket.

**What counts as an incident:** personal data seen, copied or changed by someone who should not; a lost admin phone or password; a stolen backup key;
the server taken over; ransomware; a data export sent to the wrong person.

1. **Detect and write down** the time, who noticed, and what was seen. Keep screenshots. Do not delete logs.
2. **Contain (first hour).**
   - Lost or suspected admin account: Org Admin disables the user (web: Хэрэглэгчид) or, on the server,
     `docker compose … exec api node apps/api/dist/cli/create-user.js` is NOT for this; use the web screen. All sessions of a disabled user end immediately.
   - Suspected server access: change the SSH access (DigitalOcean console → Access), `sudo bash infra/deploy/firewall.sh`, and rotate secrets:
     `JWT_SECRET` (signs everyone out; safe to change in `infra/deploy/.env` + `up -d`). **Do not change `DATA_ENCRYPTION_KEY`** without asking: stored 2FA secrets become unreadable.
   - Attack traffic: see `docs/security/ddos-response-plan.md`.
   - Do not turn the server off unless you must: you may lose evidence in memory. A snapshot (DigitalOcean → Snapshots) keeps it.
3. **Assess:** what data, which organizations, how many people, since when. The audit log (`audit_log`) and the API logs (`docker compose logs api`) say who did what.
4. **Notify:** the affected employer(s) without delay [deadline to be confirmed by the lawyer], then the competent authority and the people concerned
   **as the law requires** [lawyer to fill in: authority, deadline, content]. Use plain facts: what happened, which data, what we did, what they should do.
5. **Recover:** restore from backup if data was changed (`docs/operations/pilot-server-safety.md`, step 3), fix the cause, change every password/key that was exposed.
6. **Review within a week:** what happened, why it was possible, what changes. Add it to this page.

Keep a printed copy of this page and the phone numbers: you may not be able to open the server when you need them.

## Memory, swap and sizing

- A 2 GB server needs swap for short peaks (a deploy build, a heavy report): `sudo bash infra/deploy/swap.sh` (once; creates a 2 GB swap file, `vm.swappiness=10`; does nothing if swap exists).
- Every container has a memory cap in `infra/deploy/docker-compose.yml` (`mem_limit`: postgres 1 GB, api 640 MB, worker 512 MB, web 640 MB, caddy 192 MB). They are caps, not reservations; raise them when the server grows. Real use: `docker stats --no-stream` and `free -h`.
- When `monitor.sh` reports memory, swap or load problems repeatedly, move to the next droplet size (2 vCPU / 4 GB) before anything else.

## Weekly usage summary

`monitor-setup.sh` also installs `infra/deploy/usage-report.sh` (Monday 10:30 in Ulaanbaatar). It sends one message to the same alert address: per organization the active employees, events in the last 7 days and the last event; database size and the three biggest tables; disk, backup and point-in-time archive sizes; growth since last week and about how many weeks until the disk is full at that pace; memory and load; and how many calls were refused (phone limits, blocked addresses). Run it by hand any time: `sudo bash infra/deploy/usage-report.sh`. Offline test: `TEST_DATABASE_URL=... bash infra/deploy/test-usage-report.sh`.

A sudden jump in "events in 7 days" or in growth is the early sign of a buggy phone-app version or a stolen login. The phone limits (`apps/api/src/attendance/README.md`) cap the damage meanwhile.
