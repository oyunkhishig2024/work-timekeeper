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
- **Persistence:** bans are written to `ip_block` (migration 0015) and restored at start; the judgement state and the database are synced every 30 s, so a change by an operator applies
  to every API instance within about 30 s. With Redis (below) a ban decided by any instance is enforced by all of them immediately; the database remains the durable record and the operator channel.
- **Operator CLI** (`pnpm --filter @timekeeper/api cli:ip-blocks -- ...` or `node dist/cli/ip-blocks.js`):
  `list [--ip <addr>]`, `block <addr> [--minutes 60] [--reason ".."]`, `unblock <addr>`.
- **Logs** (JSON lines, logger `Security`): `security.ip_throttled`, `security.ip_banned` (with score, strike, signals, until), `security.ip_unblocked`,
  `security.request_refused` (once a minute per address). Alert on the number of `ip_banned` per minute (see `docs/security/ddos-response-plan.md`).
- **Tuning:** `ABUSE_THROTTLE_SCORE`, `ABUSE_BAN_SCORE`, `ABUSE_THROTTLE_PER_MINUTE`, `ABUSE_ANON_BURST_PER_10S`, `ABUSE_AUTH_BURST_PER_10S`. Switch off with
  `ABUSE_PROTECTION=off` (tests do; never in production). To judge a threshold, replay a normal working day in staging and check that no address is throttled.

## Limits (deliberate)

- Without `REDIS_URL` the state is **per process in memory** (bans are shared through the database after up to 30 s, scores are not): fine for ONE instance. With several instances set `REDIS_URL`, otherwise each instance sees only part of an attack and escalates later.
- Redis is a soft dependency. While it is unavailable (or slow) each instance judges from its own memory (an attack split over N instances then needs N times the traffic to escalate) and bans from the database are still applied by the 30 s sync. Scores and strikes that only lived in Redis are lost if Redis loses its data (restart, `allkeys-lru` eviction); active bans and recent strikes come back from the database within 30 s.
- Under extreme contention on ONE address (very many instances hammering one key) an update that loses 8 compare-and-set races in a row is served from memory for that request (fail open, not counted as an outage).
- An operator lift is applied by every instance that listed the block at its previous sync (all of them, every 30 s). A block that appeared and was lifted between two syncs is never seen by an instance that was not the one that decided it; it then ends by itself at its expiry.
- It cannot stop a flood that saturates the network before it reaches the server: that is what Cloudflare is for.
- A valid-token holder who misbehaves (a stolen token) is not caught here: that is handled by sessions, device binding and audit.
- Rate limiting by address is weak against a botnet with thousands of addresses each sending a little; Cloudflare rules and the emergency geo rule are the answer.

## Several API instances: shared state in Redis

Set `REDIS_URL` (e.g. `redis://:password@127.0.0.1:6379`) and every instance reads and writes the same per-IP state, so scores, strikes, bans, the username set (credential stuffing), the distinct-path set (enumeration), flood buckets and throttle windows are one, whichever instance a request lands on. Unset = in-process memory, exactly as before. `ABUSE_PROTECTION=off` also disables Redis use.

**Design (one approach: optimistic compare-and-set).**

- The detector rules are written once, as steps `(state, event, now) -> new state` (`abuse-detector.ts`). A state store applies a step atomically to the state of one address: `MemoryStateStore` (`abuse-state.ts`, default) or `RedisStateStore` (`abuse-redis.ts`). Nothing about scores or thresholds is known to Redis or to the Lua script.
- Redis: **one key per address**, `<ABUSE_REDIS_PREFIX><ip>` (IPv4-mapped IPv6 normalised first), a hash with `d` = the state as JSON and `v` = a version. An update reads `v` and `d` (`HMGET`, 1 round trip), runs the step on the copy, and stores it with a small generic Lua script that writes only if `v` is unchanged (and sets the TTL) (1 round trip). A lost race re-reads and re-applies the step (up to 8 times, with jitter), so no update is lost; announcements (`security.ip_banned`, ...) are made once, after the successful write. Updates of the same address inside one process are queued and applied together as one read-modify-write, so a flood from one address costs about two round trips per batch, not per request.
- Hot path: the middleware makes ONE atomic step per request (`admit` = check + count the request + note an ignored limit): 2 round trips for an anonymous request (read + write), 1 for a signed-in request from an address without state (read only). A second step happens only after a notable outcome (401/404/honeypot/...) or a signed-in success from an address that has a score.
- **TTL** per key: the longest memory the detector needs for that address: 2 hours (the score has faded, the "once per hour" scanner cooldown is over), or, when it has bans, until the last ban ended plus `strikeMemoryMinutes` (7 days), i.e. up to 8 days for a 24 h ban. Every write renews it.
- **Failure mode (never take the API down):** `ioredis` with a command timeout (`ABUSE_REDIS_TIMEOUT_MS`, default 200 ms), no offline queue (commands fail at once while disconnected), automatic reconnection. A failed or slow call is answered from the instance's own memory store immediately (**fail open**: an address nobody knows about is allowed). After `ABUSE_REDIS_BREAKER_FAILURES` (3) failures in a row the circuit opens: Redis is not called for `ABUSE_REDIS_BREAKER_COOLDOWN_SECONDS` (15 s), then one call probes it. Logged once per change: `security.redis_unavailable` (reason, retry time) and `security.redis_recovered`. Alert on the former.
- **Operator lift:** `unblock` in the CLI marks the database row lifted; the next 30 s sync of the instance(s) that listed it resets the address in Redis (blocked-until, score and throttle window cleared; the key is deleted when no strikes remain; earlier strikes are kept, as in memory mode), so all instances allow it at once. A block added by the CLI is loaded into Redis by the first instance that syncs, and enforced by all instances from then on.
- Every instance also keeps its memory store: it is the fallback during an outage and the target of the 30 s sync meanwhile.

**Running Redis on the VPS (private, no persistence needed).**

```
# /etc/redis/redis.conf (or a drop-in)
bind 127.0.0.1 -::1          # only local; for API servers on other hosts use a private network address, never a public one
protected-mode yes
requirepass <long random password>   # openssl rand -base64 32
save ""                       # no snapshots
appendonly no                 # no AOF: state is disposable, bans are durable in PostgreSQL
maxmemory 256mb
maxmemory-policy allkeys-lru  # under pressure forget the least recently used addresses, never refuse writes
```

Then `REDIS_URL=redis://:<password>@127.0.0.1:6379` (use `rediss://` over a network). Sizing: a key is roughly 0.5-1.5 KB, so 256 MB hold several 100 000 addresses; each address that sent only ordinary anonymous requests expires after 2 hours. Block port 6379 at the firewall as well (see `docs/security/`). docker-compose (`infra/docker/docker-compose.yml`) has a `redis` service bound to 127.0.0.1 for development. Eviction is safe: a lost entry only means an address starts from a clean score; active bans are restored from `ip_block` by the sync.

**Inspect and clear** (`<prefix>` = `ABUSE_REDIS_PREFIX`, default `tk:abuse:`):

```
redis-cli --scan --pattern 'tk:abuse:*' | head       # addresses with state (use SCAN, never KEYS, in production)
redis-cli HGET  tk:abuse:203.0.113.7 d               # the state (JSON: score, blockedUntil, bans, counts, ...)
redis-cli PTTL  tk:abuse:203.0.113.7                 # remaining lifetime in ms
redis-cli DEL   tk:abuse:203.0.113.7                 # forget one address (also lifts a ban held only in Redis; the sync re-applies it if the database still lists it)
node dist/cli/ip-blocks.js unblock 203.0.113.7       # the normal way to lift a ban (database + Redis)
```

Keys that exist: only `<prefix><ip>`. Use a different `ABUSE_REDIS_PREFIX` per environment sharing one Redis (staging vs production).

Pure logic: `abuse-detector.ts` (unit tests in `test/unit/abuse-detector.test.ts`, with an injected clock). HTTP side: `abuse.middleware.ts`.
State stores: `abuse-state.ts` (memory), `abuse-redis.ts` (Redis, circuit breaker). Persistence and sync: `abuse.service.ts`, `ip-block.store.ts`.
End-to-end: `test/e2e/abuse-protection.test.ts`; shared state: `test/unit/abuse-redis.test.ts` (starts a throwaway `redis-server`; skipped with a warning when the binary is missing) and `test/e2e/abuse-protection-redis.test.ts` (two API instances, one Redis; needs PostgreSQL too).
