# DDoS response plan (playbook)

**Status:** v1, written _before_ any attack. **Owner:** [FILL IN: name]. **Review:** every quarter and after every incident. **Rehearsal:** a drill every quarter (section 9).
Anything in `[FILL IN]` must be completed before go-live; a playbook with empty names does not work at 08:30 on a Monday.

How it fits: the layers are described in `docs/security/README.md` and `waf-hostinger-cloudflare.md`; the SLO is PRD 25.1 (pilot tier: 99.5 % API availability 06:00–20:00; about two hours of unplanned downtime a month is tolerated). Attendance data is safe during an outage because the phones keep their events and upload later (PRD 6.8: offline queue, late-sync window 24 hours, idempotent uploads).

---

## 1. What we are defending against

| Kind                                | What it looks like                                                     | First defence                                                           | Our reaction                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Volumetric / protocol flood (L3/L4) | Network saturated, server unreachable, nothing in app logs             | Cloudflare edge; Hostinger network anti-DDoS                            | Usually absorbed without action. If the _origin address leaked_: section 6 (new origin) |
| HTTP flood (L7)                     | Many valid-looking requests, CPU / connections high, 5xx, slow replies | Cloudflare rate limits and rules; nginx limits; API adaptive protection | Sections 4–5                                                                            |
| Credential stuffing / brute force   | Spike of failed sign-ins on `/v1/auth/*`, many usernames               | Cloudflare rate limit; nginx; API throttle → ban; account lockout       | Section 4 (logs)                                                                        |
| Scanning / probing                  | `/.env`, `/wp-login.php`, random 404s                                  | Cloudflare custom rule; API honeypot scoring                            | Usually automatic                                                                       |
| Slow attacks (Slowloris)            | Many open connections, few requests                                    | nginx timeouts and `limit_conn`                                         | Check nginx connection count                                                            |

**Not an attack (rule it out first):** a real peak. Expected load is small (about 320 employees; a burst when shifts start, around 08:30 and 20:00, and when a new app version makes all phones sync). A traffic jump that coincides with a release, a holiday import, a mass sign-in after an outage (the offline queues flushing) or a report run is **not** an attack. Check the _deploy log_ and the _calendar_ first.

---

## 2. Baselines and detection

Record these when things are normal ([FILL IN after the first two weeks]); an incident is declared when a signal is far from its baseline:

| Signal                                                                                              | Where                                                        | Normal      | Alert at                       |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------- | ------------------------------ |
| API availability (uptime monitor, 1-minute checks of `https://api.<domain>/v1/health` from outside) | [FILL IN: UptimeRobot / Better Stack / Hostinger monitoring] | up          | 2 failed checks in a row       |
| Requests per second at Cloudflare                                                                   | Cloudflare > Analytics                                       | [FILL IN]   | > 10× normal for 5 minutes     |
| 5xx rate                                                                                            | API / nginx logs                                             | < 1 %       | > 2 % for 5 minutes (PRD 25.1) |
| API p95 latency                                                                                     | logs / metrics                                               | [FILL IN]   | > 3× for 5 minutes             |
| Server CPU / memory / open connections                                                              | Hostinger VPS metrics, `ss -s`                               | [FILL IN]   | CPU > 85 % for 5 minutes       |
| Bans issued by the API                                                                              | log lines `security.ip_banned`                               | few per day | > 10 in 10 minutes             |
| Failed sign-ins                                                                                     | audit log / `LOGIN_FAILURE`                                  | few         | > 100 in 5 minutes             |
| Cloudflare "DDoS attack" / "Security events" notifications                                          | Cloudflare notifications → incident channel                  | none        | any                            |

Alerts go to the **incident channel** [FILL IN: e.g. a Telegram / Viber / Slack group "Timekeeper-Incident"] and the on-call phone.

---

## 3. People and notification tree

| Role                                              | Who                       | Backup    | Does                                                                                |
| ------------------------------------------------- | ------------------------- | --------- | ----------------------------------------------------------------------------------- |
| **Incident Commander (IC)**                       | [FILL IN]                 | [FILL IN] | Owns the incident, decides severity, authorises toggles in section 5, keeps the log |
| **Technical lead**                                | [FILL IN] (the developer) | [FILL IN] | Runs the technical steps                                                            |
| **Account owner (Cloudflare, domain, Hostinger)** | [FILL IN]                 | [FILL IN] | Has the logins and two-step codes; can contact the providers                        |
| **Communications lead**                           | [FILL IN] (HR / Ganbat)   | [FILL IN] | Tells employees, managers and the customer organization                             |
| **Executive sponsor**                             | [FILL IN]                 |           | Informed at SEV 1; approves paid emergency measures                                 |

Contacts (keep a printed copy; the incident may take the chat tool down too):

| What                                                                                                                              | Contact                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| IC / Technical lead phone                                                                                                         | [FILL IN]                                                                                                  |
| Hostinger support (24/7 live chat in hPanel; for a VPS attack ask them to check the network and, if needed, null-route or filter) | hPanel > Help; account e-mail [FILL IN]; VPS ID [FILL IN]                                                  |
| Cloudflare                                                                                                                        | Dashboard > Support. **The Free plan has no support contact**; community forum only. Consider a paid plan. |
| Domain registrar                                                                                                                  | [FILL IN]                                                                                                  |
| Customer organization contact (tenant "310")                                                                                      | [FILL IN]                                                                                                  |

**Notification timeline (from the moment the first alert is seen):**

| When                          | Who is told                                     | How                         |
| ----------------------------- | ----------------------------------------------- | --------------------------- |
| T+0                           | Technical lead (alert)                          | page / call                 |
| T+5 min, still degraded       | Incident Commander                              | call                        |
| T+15 min, user-visible impact | Communications lead → employees/HR (template A) | message                     |
| T+30 min, SEV 1               | Executive sponsor, customer contact             | call                        |
| every 30 min                  | status update (template B)                      | incident channel + customer |
| resolved                      | all of the above (template C)                   | message                     |

---

## 4. Severity levels

| Level     | Meaning                                      | Examples                                                  | Target                                      |
| --------- | -------------------------------------------- | --------------------------------------------------------- | ------------------------------------------- |
| **SEV 3** | Attack seen, service fine                    | Cloudflare notification, many bans, WAF blocking a lot    | Watch; tune; no user message                |
| **SEV 2** | Degraded: slow, some errors, sign-in trouble | 5xx 2–20 %, p95 ≫ normal, some employees cannot sign in   | Mitigate within 30 min                      |
| **SEV 1** | Down for users                               | health checks failing, app cannot sync, admin unreachable | Mitigate within 15 min, update every 30 min |

SEV 1 during working hours (06:00–20:00) counts against the SLO; log start and end times.

---

## 5. The playbook

Work top to bottom. Do not skip step 0. **The Incident Commander writes every action and time in the incident log** (template in section 10).

### Step 0: confirm and classify (≤ 5 min)

1. Is the uptime monitor failing from several places? Open `https://api.<domain>/v1/health` from a phone on mobile data. Open the Cloudflare dashboard: is Cloudflare itself fine (cloudflarestatus.com)?
2. Any deploy, import, migration or release in the last hour? Is a shift change happening? (If yes: possibly not an attack; check the queue flush first.)
3. Cloudflare > Security > Events and Analytics: top source countries, addresses, paths, user agents, methods. On the server: `journalctl -u timekeeper-api --since "15 min ago" | grep security.` and `ss -s`, `top`.
4. Classify with section 1 and set the severity.

### Step 1: switch on what is already prepared (≤ 10 min)

Pick by what you saw. Each is reversible; each is logged.

| If the traffic is…                       | Do this                                            | How                                                                                                                               | Side effect                                                                                                 |
| ---------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| From outside Mongolia (most attacks)     | **Emergency rule "Mongolia only" on the API host** | `infra/cloudflare/apply.sh emergency on`                                                                                          | Staff / employees abroad are blocked. Add their addresses to the inline list in `waf-rules.json` and re-run |
| Hitting the web admin pages in a browser | **Browser challenge on the admin host**            | included in `emergency on`                                                                                                        | Admin users solve a challenge; the **API host and the mobile app are not challenged** (they cannot)         |
| One or few addresses / a small network   | Block them                                         | Cloudflare > Security > WAF > Tools (IP access rules), and `node dist/cli/ip-blocks.js block <ip> --minutes 1440 --reason "ddos"` | None for others                                                                                             |
| Sign-in endpoints                        | Tighten the sign-in rate limit                     | Edit `rateLimitRules` in `waf-rules.json` (lower `requests_per_period`), `apply.sh apply`                                         | Real users may need a retry                                                                                 |
| A specific expensive path                | Block that path at Cloudflare                      | add a path rule in `waf-rules.json`                                                                                               | That feature is down; tell users                                                                            |

Do **not** turn on zone-wide "I'm Under Attack" or Bot Fight Mode: they break the mobile app and the admin's API calls (see `waf-hostinger-cloudflare.md` 2.4).

### Step 2: protect the origin (≤ 10 min)

1. On the server: `ss -tn state established '( sport = :443 )' | wc -l`; `nginx -T | grep limit_` to confirm the limits are active.
2. Anything reaching the server directly (not through Cloudflare)? `ufw status` must show the web port open only to Cloudflare ranges; if not, run `infra/hostinger/allow-cloudflare-only.sh` now. If the _origin address has leaked_ (the direct address answers), go to step 4.
3. If CPU is the limit and traffic is real: restart the API (`systemctl restart timekeeper-api`); the adaptive bans are stored in the database and survive the restart.
4. Database: `select count(*) from pg_stat_activity;` If the database is the bottleneck, stop non-essential jobs (report exports, imports) and ask HR to pause them.

### Step 3: tell people (≤ 15 min from user impact)

Send template A to HR / managers and employees, and update the status page. Remind HR of the fallback: employees on a phone keep recording locally; HR can record attendance by hand (the _manual attendance_ flag) for people who cannot use the app at all.

### Step 4: change where traffic goes (SEV 1 that the steps above do not fix, or the origin address leaked)

Options, in this order:

1. **Serve a static status / maintenance page** instead of the failing origin. Prepare it in advance on a separate host (Cloudflare Pages or any static host) at `status.<domain>` and keep it published. Cloudflare > Rules > use a custom error page, or point the `admin` host at the static page while the API recovers. (The `api` host should return an error, not a page: the app handles errors and keeps its queue.)
2. **Move the origin.** Keep a **standby VPS** [FILL IN: second Hostinger VPS in another data center, created from a snapshot of the production server, firewalled the same way, powered but not receiving traffic]. Failover: restore the latest database backup / switch the standby to read the replica or backup (RPO and RTO per PRD 25.2: RPO ≤ 15 min, RTO ≤ 8 h; **rehearse this**), then point the tunnel / the proxied DNS record of `api` and `admin` to the standby. Because traffic goes through Cloudflare the change is effective within about a minute.
3. If the **old origin address leaked**: after the move, make the old address useless (firewall deny-all), and never reuse it. Hostinger can assign or rebuild a server with a new address [FILL IN: procedure and contact].
4. **Ask the provider.** Open a live chat with Hostinger support: describe the attack, give times and the VPS ID, ask whether they see volumetric traffic and can filter or null-route. For Cloudflare on a paid plan, open a support case; on a Free plan, consider upgrading during the attack if sections 1–3 are not enough (the plan change is immediate).

### Step 5: recovery and stand-down

1. When traffic and errors are back to baseline for **30 minutes**, switch measures off **one at a time**, newest first, watching the numbers for 10 minutes between steps: emergency rules (`apply.sh emergency off`), temporary rate-limit changes (restore `waf-rules.json`), manual blocks that are no longer needed (`ip-blocks.js unblock <ip>`).
2. Expect a **wave of delayed events** from phones when service returns (offline queues flush). That is normal; do not mistake it for a new attack. Watch ingest lag.
3. Recompute: late-synced events may change statuses for the day (PRD 6.8); tell HR to re-check "Ирээгүй" for the incident window before treating anyone as absent. If the outage covered a shift start, have HR review that day's absences manually.
4. Send template C. Close the incident log.

---

## 6. Quick reference: what gets toggled

| Switch                                                     | Where                                            | Who may switch        | Effect                                     |
| ---------------------------------------------------------- | ------------------------------------------------ | --------------------- | ------------------------------------------ |
| Emergency rules on/off                                     | `infra/cloudflare/apply.sh emergency on\|off`    | IC or Technical lead  | Mongolia-only API; challenge on admin host |
| Log-only mode for all rules (a legitimate user is blocked) | `apply.sh log`                                   | Technical lead        | WAF stops blocking; use briefly            |
| Block / unblock an address at the app                      | `node dist/cli/ip-blocks.js block\|unblock <ip>` | Technical lead        | Within ~30 s on all API instances          |
| Firewall: web only from Cloudflare                         | `infra/hostinger/allow-cloudflare-only.sh`       | Technical lead        | Closes the direct path                     |
| Pause imports/exports                                      | tell HR                                          | Communications lead   | Less load                                  |
| Status page                                                | [FILL IN]                                        | Communications lead   |                                            |
| Failover to standby origin                                 | step 4.2                                         | IC with Account owner | Traffic moves to standby                   |

## 7. Where traffic goes (summary)

- Normal: Cloudflare → (tunnel or firewall-restricted) → nginx → API.
- Under L7 attack: same path, with emergency rules in front; hostile addresses refused at Cloudflare, at nginx or by the API.
- Origin lost or overloaded beyond repair: admin host → static status page; API host → error responses (apps queue locally); then the **standby VPS** takes over the same host names.

## 8. Communication templates

**A. Employees / HR (Mongolian), when users are affected**

> Сайн байна уу. Цагийн бүртгэлийн системд түр саатал гарсан байна. Таны утас ирцийг өөрөө хадгалж байгаа тул **ирц алдагдахгүй**, холболт сэргэмэгц автоматаар илгээгдэнэ. Аппыг устгах, дахин суулгах хэрэггүй. Дараагийн мэдээллийг [цаг] цагт өгнө. — [Нэр, холбоо барих утас]

**B. Status update (internal / customer)**

> [Цаг] — Төлөв: [SEV]. Юу мэдэгдэж байна: [товч]. Юу хийж байна: [алхам]. Хэрэглэгчид юу мэдрэх вэ: [ ]. Дараагийн шинэчлэл: [цаг].

**C. Resolved**

> Систем хэвийн ажиллаж байна ([цаг] -аас [цаг] хүртэл саатсан). Саатлын үеэр бүртгэгдсэн ирц утаснаас ирж байна, зарим өдрийн төлөв дахин тооцогдож болно. HR [өдөр] өдрийн «Ирээгүй» мөрүүдийг шалгана. Дэлгэрэнгүй тайлан [огноо]-нд.

**D. English (for providers)**

> Our production service (VPS ID [ ], IP [ ]) has been under a suspected DDoS since [time UTC]. Symptoms: [ ]. Already filtered at Cloudflare (zone [ ]). Please check for volumetric traffic towards our address and advise on filtering or null-routing. Contact: [name, phone].

## 9. Drills and upkeep

- **Quarterly drill** (30 minutes, announced): with permission, generate load against **staging** (k6 or hey) from outside; practise steps 0–1 and `apply.sh emergency on/off`; time each step. Never run load tests against production or someone else's server.
- **Twice a year:** rehearse the standby failover and a database restore (this is also the PRD 25.2 restore test).
- After any change to hosting, DNS, the WAF file or the contact list: re-run the verification checklist in `waf-hostinger-cloudflare.md` section 4 and update this document.
- Keep the Cloudflare, Hostinger and registrar logins and two-step recovery codes with **two** people, in a password manager, plus a sealed paper copy.

## 10. Incident log template

```
Incident: [id]     Severity: [ ]     IC: [ ]     Tech lead: [ ]
Start (first alert): [UTC+8]   Detected by: [ ]
Timeline:  [time] [who] [action / observation]
Measures switched on: [ ]   switched off: [ ]
Customer impact: [users, duration, attendance affected?]
End: [time]   Duration: [ ]
Root cause / attack type: [ ]
Follow-ups (owner, date): [ ]
```

**Post-incident review within 3 working days** (blameless): what we saw first, what slowed us down, which switch helped, which rule or threshold to change, what to add to this playbook. File the review next to this document.
