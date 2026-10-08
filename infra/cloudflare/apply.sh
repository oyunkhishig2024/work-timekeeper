#!/usr/bin/env bash
# Applies infra/cloudflare/waf-rules.json to a Cloudflare zone through the Rulesets API, and flips the emergency rules.
#
#   CF_API_TOKEN=... CF_ZONE_ID=... ./apply.sh plan            show what would be sent (no network)
#   CF_API_TOKEN=... CF_ZONE_ID=... ./apply.sh apply           replace the zone's custom rules and rate-limit rule
#   CF_API_TOKEN=... CF_ZONE_ID=... ./apply.sh log             same rules but every action set to "log" (rollout / tuning)
#   CF_API_TOKEN=... CF_ZONE_ID=... ./apply.sh emergency on    switch the EMERGENCY rules on  (off: switch them off)
#
# The token needs: Zone > Zone WAF > Edit (and Zone Settings > Read). Create it at dash.cloudflare.com > My Profile > API Tokens,
# limited to this one zone. NOTE: "apply" REPLACES all custom rules of the zone with the ones in the file.
# Not tested against a live account by the developers of this repository: run `plan`, then `log`, check Security > Events, then `apply`.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
file="${RULES_FILE:-$here/waf-rules.json}"
api="https://api.cloudflare.com/client/v4"
cmd="${1:-plan}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

payload_custom() {
  local mode="$1" emergency="${2:-keep}"
  jq --arg mode "$mode" --arg emergency "$emergency" '{
    rules: [ .customRules[] | {
      ref, description, expression,
      action: (if $mode == "log" then "log" else .action end),
      enabled: (if (.ref | startswith("emergency-")) then (if $emergency == "on" then true elif $emergency == "off" then false else .enabled end) else .enabled end)
    } ]
  }' "$file"
}
payload_ratelimit() {
  local mode="$1"
  jq --arg mode "$mode" '{
    rules: [ .rateLimitRules[] | {
      ref, description, expression, ratelimit,
      action: (if $mode == "log" then "log" else .action end),
      enabled
    } ]
  }' "$file"
}

put_phase() {
  local phase="$1" body="$2"
  : "${CF_API_TOKEN:?set CF_API_TOKEN}" "${CF_ZONE_ID:?set CF_ZONE_ID}"
  curl -fsS -X PUT "$api/zones/$CF_ZONE_ID/rulesets/phases/$phase/entrypoint" \
    -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data "$body" \
    | jq '{success, errors, rules: [.result.rules[]? | {description, action, enabled}]}'
}

case "$cmd" in
  plan)
    echo "== custom rules (phase http_request_firewall_custom)"; payload_custom block | jq .
    echo "== rate limiting (phase http_ratelimit)"; payload_ratelimit block | jq .
    ;;
  apply | log)
    put_phase http_request_firewall_custom "$(payload_custom "$([ "$cmd" = log ] && echo log || echo block)")"
    put_phase http_ratelimit "$(payload_ratelimit "$([ "$cmd" = log ] && echo log || echo block)")"
    ;;
  emergency)
    state="${2:-}"; [ "$state" = on ] || [ "$state" = off ] || { echo "usage: $0 emergency on|off" >&2; exit 2; }
    put_phase http_request_firewall_custom "$(payload_custom block "$state")"
    echo "Emergency rules switched $state. Write it in the incident log (docs/security/ddos-response-plan.md)."
    ;;
  *) echo "usage: $0 plan|apply|log|emergency on|off" >&2; exit 2 ;;
esac
