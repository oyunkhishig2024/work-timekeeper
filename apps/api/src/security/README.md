# Adaptive abuse protection

Behaviour-based throttling and temporary bans per client IP, inside the API. It is the **fourth** layer of defence
(Cloudflare WAF → firewall → nginx → this); see `docs/security/`. It is attached before everything else in `main.ts`
(`applyAbuseProtection(app)`), so it also sees URLs outside `/v1` and unknown paths (`/.env`, `/wp-login.php`).

## What it judges

Not only _how many_ requests an address makes but _what it does_. Every finished request can add points to the address' score
(unauthenticated traffic only); the score halves every 10 minutes.

| Signal                                                                                  | Points                                     | Why                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Request for a well-known attack target (`/.env`, `/.git`, `/wp-*`, `*.php`, `../`, ...) | 60                                         | Nothing legitimate asks for these                              |
| Credential stuffing: 5 distinct usernames failing within 5 minutes                      | +45 (once per window)                      | A forgetful user fails with one username                       |
| Failed sign-in                                                                          | 8                                          |                                                                |
| Path enumeration: 15 distinct unknown URLs in a minute                                  | +35                                        | The same missing URL repeated is a broken link and scores once |
| Unknown URL (new path)                                                                  | 3                                          |                                                                |
| Scanner user agent (sqlmap, nikto, nmap ...)                                            | 25 (once per hour)                         |                                                                |
| 401/403 on other routes without a valid token                                           | 3                                          |                                                                |
| Malformed request (400, 413, 414, 415, 431)                                             | 2                                          |                                                                |
| Ignoring a throttle / ban (requests keep coming after 429)                              | 2 each                                     | Behaviour that proves automation                               |
| Anonymous flood: > 100 requests in a 10 s bucket                                        | 10 per bucket, +40 when 3 buckets in a row | Volume counts, but only as one signal                          |
| Successful request with a valid access token                                            | −1                                         | Healthy traffic from a shared address offsets noise            |

## Escalation

| Score | Level           | What happens                                                                                                                   |
| ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| < 40  | NORMAL          | nothing                                                                                                                        |
| ≥ 40  | **THROTTLE**    | anonymous requests limited to 20 per minute (then `429` + `Retry-After`)                                                       |
| ≥ 100 | **BLOCK (ban)** | anonymous requests refused with `429 IP_TEMPORARILY_BLOCKED` + `Retry-After`; the sign-in endpoints are closed to that address |

Ban length grows with repeat offences within 7 days (counted from the end of the previous ban): **15 min, 1 h, 6 h, 24 h** (the last repeats).
After a ban the score restarts at 35, so a repeat is punished quickly. Two probes of attack paths are enough for a first ban; a forgetful user
mistyping a password never reaches the throttle.

**Signed-in people are not punished for an attacker sharing their address** (carrier-grade NAT on mobile networks is common): a request with a
_valid, unexpired access token_ (signature verified, not just present) passes even from a banned address, never adds points and lowers the score.
A garbage token counts as anonymous. Authenticated traffic is only slowed if one address exceeds 400 requests per 10 s, and that never causes a ban.
Employees behind the same address can therefore keep working and checking in; an attacker without a token cannot sign in or probe.

Never judged: loopback (`ABUSE_ALLOW_LOOPBACK`), and addresses in `ABUSE_ALLOWLIST` (office, uptime monitor, load-test source).

## Operation

- **Client address:** `TRUST_PROXY` must match the proxies in front (`1` = nginx). Wrong → everybody shares one address or addresses can be forged.
- **Persistence:** bans are written to `ip_block` (migration 0015) and restored at start; memory and database are synced every 30 s, so a change by an operator applies
  to every API instance within about 30 s.
- **Operator CLI** (`pnpm --filter @timekeeper/api cli:ip-blocks -- ...` or `node dist/cli/ip-blocks.js`):
  `list [--ip <addr>]`, `block <addr> [--minutes 60] [--reason ".."]`, `unblock <addr>`.
- **Logs** (JSON lines, logger `Security`): `security.ip_throttled`, `security.ip_banned` (with score, strike, signals, until), `security.ip_unblocked`,
  `security.request_refused` (once a minute per address). Alert on the number of `ip_banned` per minute (see `docs/security/ddos-response-plan.md`).
- **Tuning:** `ABUSE_THROTTLE_SCORE`, `ABUSE_BAN_SCORE`, `ABUSE_THROTTLE_PER_MINUTE`, `ABUSE_ANON_BURST_PER_10S`, `ABUSE_AUTH_BURST_PER_10S`. Switch off with
  `ABUSE_PROTECTION=off` (tests do; never in production). To judge a threshold, replay a normal working day in staging and check that no address is throttled.

## Limits (deliberate)

- State is **per process in memory** (bans are shared through the database, scores are not). With several API instances each sees part of the traffic; a shared store (Redis) is the next step if the API is scaled out.
- It cannot stop a flood that saturates the network before it reaches the server: that is what Cloudflare is for.
- A valid-token holder who misbehaves (a stolen token) is not caught here: that is handled by sessions, device binding and audit.
- Rate limiting by address is weak against a botnet with thousands of addresses each sending a little; Cloudflare rules and the emergency geo rule are the answer.

Pure logic: `abuse-detector.ts` (unit tests in `test/unit/abuse-detector.test.ts`, with an injected clock). HTTP side: `abuse.middleware.ts`.
Persistence and sync: `abuse.service.ts`, `ip-block.store.ts`. End-to-end: `test/e2e/abuse-protection.test.ts`.
