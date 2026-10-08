# WAF in front of the whole stack: Cloudflare + Hostinger VPS

**Goal:** malicious traffic is filtered _before_ it reaches the server, for the whole stack (API, web admin, anything else on the domain), not endpoint by endpoint.

## 1. Decision and why

Hostinger protects its network (it advertises its own anti-DDoS on the network switches) and VPS plans have a firewall, but I could **not confirm** that a Hostinger VPS comes with an application-layer WAF you can configure (rules for SQL injection, XSS, bad bots and so on). A firewall in the Hostinger panel works on addresses and ports (layer 3/4); it cannot read an HTTP request. **Check the current Hostinger VPS plan and hPanel firewall documentation yourself** before relying on a Hostinger-side WAF.

So the WAF is **Cloudflare**, placed between users and the Hostinger server:

```
 users / mobile apps / admin browsers
              |
      Cloudflare edge  <- DDoS mitigation, WAF managed rules, our custom rules, rate limiting, TLS
              |   (only Cloudflare can reach the next hop)
   Hostinger VPS firewall (ufw)  <- web port open to Cloudflare ranges only; SSH to admin addresses only
              |
            nginx   <- real client IP, coarse limits, slow-client protection
              |
          Timekeeper API (adaptive abuse protection)   +   PostgreSQL (not reachable from outside)
```

Hostinger even offers a one-click **Cloudflared** (Cloudflare Tunnel) application for VPS plans; a tunnel makes only _outbound_ connections from the VPS to Cloudflare, so **no inbound web port is open at all** and the server address stays hidden. That is the strongest option and the recommended one if it fits (Option A below). Option B (proxied DNS + firewall allowlist) works anywhere.

Assumptions: a Hostinger **VPS** (KVM) running nginx, Node (the API) and PostgreSQL; a domain you control; two host names: `api.<domain>` (API: mobile apps and the admin web's XHR calls) and `admin.<domain>` (the web admin pages).

## 2. Setup, in order

### 2.1 Cloudflare account and DNS

1. Create a Cloudflare account, **enable two-step login on it** (this account can take your whole service offline).
2. Add the domain; move the domain's nameservers to Cloudflare (at the registrar, or at Hostinger if the domain is registered there).
3. Create DNS records for `api` and `admin` pointing to the VPS address with the **orange cloud (Proxied)** on. Remove every other record that points at the VPS address (old `ftp.`, `mail.`, `direct.` records reveal the server address). A mail record cannot be proxied, so keep mail on a different host or accept that it exposes that address.
4. SSL/TLS mode **Full (strict)**; create a **Cloudflare Origin CA certificate** for `api.<domain>` and `admin.<domain>` and install it in nginx (`infra/nginx/timekeeper-api.conf`); turn on **Authenticated Origin Pulls**; **Always Use HTTPS**; minimum TLS 1.2.

### 2.2 Lock the origin (the step people forget)

**Option A, Tunnel:** install the Cloudflared application from the Hostinger panel (or `cloudflared` yourself), create a tunnel, route `api.<domain>` and `admin.<domain>` to `http://localhost:443` or `:80`. Then close the web ports completely: `sudo OPEN_WEB=no ADMIN_IPS="..." infra/hostinger/allow-cloudflare-only.sh`. In nginx add `set_real_ip_from 127.0.0.1;` to `/etc/nginx/cloudflare-realip.conf`.

**Option B, proxied DNS:** run `sudo ADMIN_IPS="<your addresses>" infra/hostinger/allow-cloudflare-only.sh`. It downloads Cloudflare's published address ranges, opens 443 only to them, opens SSH only to `ADMIN_IPS`, denies everything else and writes the nginx `set_real_ip_from` list. Re-run it weekly (cron). If you also use Hostinger's panel firewall, mirror the same rules there (verify in hPanel what it supports).

Verify: `curl -k --resolve api.<domain>:443:<VPS-IP> https://api.<domain>/v1/health` from your laptop must **fail** (timeout). If it answers, the WAF can be bypassed.

PostgreSQL listens on `127.0.0.1` only. Never open 5432.

### 2.3 nginx and the API

1. Install `infra/nginx/timekeeper-api.conf` (fill in host names and certificate paths). It restores the real visitor address (`CF-Connecting-IP`) and sets coarse limits and timeouts.
2. Start the API with `TRUST_PROXY=1` (one proxy: nginx). **This matters**: the adaptive protection bans addresses; with a wrong setting every visitor looks like Cloudflare (one address banned = everybody banned) or clients can fake their address. Test: call `/v1/health` through Cloudflare and look at the address in the API log lines.
3. `ABUSE_PROTECTION=on` (default). Add your office / uptime-monitor addresses to `ABUSE_ALLOWLIST`.

### 2.4 Cloudflare WAF

1. **Managed rules:** Security > WAF > Managed rules: enable the **Cloudflare Managed Ruleset** (available on the Free plan in a reduced form; the OWASP Core ruleset needs a paid plan, check the current plan page). Start with _Log_, review Security > Events for a few days, then _Block_.
2. **Custom rules and rate limit:** edit host names in `infra/cloudflare/waf-rules.json`, then:
   ```bash
   export CF_API_TOKEN=...   # API token limited to this zone: Zone WAF > Edit
   export CF_ZONE_ID=...
   infra/cloudflare/apply.sh plan      # show the payload
   infra/cloudflare/apply.sh log       # all actions set to "log": watch Security > Events for a week
   infra/cloudflare/apply.sh apply     # enforce
   ```
   What the rules do: block well-known attack paths and scanner tools and impossible HTTP methods; answer only under `/v1/` on the API host; rate-limit the sign-in endpoints per address; and two **emergency** rules that are switched off until an attack (Mongolia-only access to the API, and a browser challenge on the admin host). They fit the Free plan (check the current limits: about 5 custom rules and 1 rate-limiting rule). `apply.sh` replaces the zone's custom rules with this file, so the file is the source of truth: change rules in the file, not in the dashboard.
3. **Do not turn on** "I'm Under Attack" mode or "Bot Fight Mode" for the zone. They show a browser challenge that **a mobile app and an XHR call cannot solve**: the attendance app and the admin web's API calls would break. The `api` host is protected with blocking and rate limiting only (no challenges); only the `admin` page host may use a challenge (the emergency rule).
4. **Caching:** nothing from the API is cached (Cache Rules: bypass cache for `api.<domain>`). Static assets of the web admin can be cached.
5. **DDoS protection:** Cloudflare's HTTP DDoS rules are on by default on every plan; leave their sensitivity at the default and do not disable rules. Turn on **security notifications** (Notifications > DDoS attack alerts, Security events) to the incident channel (see the response plan).
6. **Security level:** Medium on the zone (do not use High / Under Attack zone-wide for the reason above).

### 2.5 Mobile app and the WAF

The app calls `api.<domain>` with a normal HTTPS client. Make sure it sends a non-empty `User-Agent` (the rule blocks empty ones). Certificate pinning to the _Cloudflare_ edge certificate is **not** recommended (it rotates); pin the public key only if you can update the app before it changes.

## 3. Rollout and false positives

1. Everything in _Log_ first (`apply.sh log`) for at least a week of normal working days, including a shift change and the 08:30 check-in peak.
2. Review Security > Events: anything the app or HR legitimately did that would have been blocked is a false positive: fix the rule in the file.
3. Switch to enforcing. Keep `apply.sh log` handy as the "something legitimate is being blocked" rollback.
4. A person who is blocked sees a Cloudflare block page with a **Ray ID**; they send it to HR/IT, who find the event in Security > Events and add an exception (an address allowlist rule) if justified.

## 4. Verification checklist (run after setup and after every change)

- [ ] `curl https://api.<domain>/.env` is blocked at Cloudflare (403 with a Cloudflare page), not answered by the API.
- [ ] `curl -A sqlmap https://api.<domain>/v1/health` is blocked.
- [ ] `curl https://api.<domain>/anything` (outside `/v1/`) is blocked.
- [ ] `curl https://api.<domain>/v1/health` works; the app signs in and checks in.
- [ ] 30 quick sign-in requests from one address get blocked by the rate limit.
- [ ] The server address does not answer directly (section 2.2).
- [ ] The API log shows the **visitor's** address, not Cloudflare's.
- [ ] `apply.sh emergency on` then `off` works and the Cloudflare dashboard shows the rule state.
- [ ] Notifications arrive in the incident channel (send a test).

## 5. What this does not do

- It cannot stop an attacker who is allowed in: stolen valid tokens, a compromised employee account. Those are handled by the application (short-lived tokens, session checks, audit, device binding).
- Cloudflare's **Free** plan has no support contact or SLA and a short list of rules; if the service becomes business-critical, a paid plan (Pro or Business) buys more rules, longer rate-limit windows and (Business+) support. Decide this with the cost of an hour of downtime in mind.
- Hostinger VPS does not provide managed PostgreSQL with point-in-time recovery: backups and restore tests (PRD 25.2: RPO 15 minutes) are yours to build on the VPS (WAL archiving to a separate provider). That is an availability concern outside this document, but a DDoS recovery that needs the database restored must be rehearsed.
