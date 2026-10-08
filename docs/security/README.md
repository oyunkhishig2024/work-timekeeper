# Security: abuse, WAF and DDoS

| Document                                                                       | What it is                                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| [waf-hostinger-cloudflare.md](waf-hostinger-cloudflare.md)                     | How the WAF is put in front of the whole stack (Cloudflare in front of the Hostinger VPS), step by step, with the rules as files |
| [ddos-response-plan.md](ddos-response-plan.md)                                 | The playbook for the day the service goes down under a flood: who is told, what is switched, where traffic goes                  |
| [../../apps/api/src/security/README.md](../../apps/api/src/security/README.md) | The adaptive rate limiting inside the API (behaviour-based throttle -> temporary ban)                                            |
| `infra/cloudflare/`                                                            | `waf-rules.json` (rules as data) and `apply.sh` (apply / emergency switches through the Cloudflare API)                          |
| `infra/nginx/timekeeper-api.conf`                                              | Reverse-proxy config for the VPS: real client IP, coarse limits, slow-client protection                                          |
| `infra/hostinger/allow-cloudflare-only.sh`                                     | Firewall script: web ports reachable only from Cloudflare                                                                        |

## The layers (outside in)

1. **Cloudflare** (DNS proxy): absorbs volumetric and protocol attacks (L3/L4), runs the WAF (managed rules + our custom rules) and rate limits, hides the server address.
2. **VPS firewall** (Hostinger / ufw): the server answers nothing but Cloudflare (and SSH from admin addresses), so the WAF cannot be bypassed by going to the server address.
3. **nginx**: real client IP, per-address request and connection limits, header/body timeouts and size limits.
4. **API adaptive protection**: judges the behaviour of each address (failed logins across many usernames, probing, enumeration, floods) and escalates from throttling to a temporary ban, without punishing signed-in people who share an address.
5. **Per-endpoint limits and lockout** that already existed: sign-in throttle, account lockout after 5 failures.

No single layer is trusted alone; each one assumes the one in front of it can fail.
