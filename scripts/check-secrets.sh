#!/usr/bin/env bash
# Looks for secrets in the tracked files and in the whole git history: private keys, age secret keys, cloud and chat tokens,
# and secret-looking values assigned to the project's secret variables. Exits 1 and names the file and line on a hit.
#   bash scripts/check-secrets.sh            (CI runs it with the full history checked out)
# A value is allowed when it is an obvious placeholder or one of the known public sample values below.
set -euo pipefail
cd "$(dirname "$0")/.."

# Known public sample values that were committed once as examples (never used on a server; setup.sh generates real ones).
ALLOW='MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=|change-me-change-me-change-me-change-me-change-me'
HARD='AGE-SECRET-KEY-1[A-Z0-9]{50,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{40,}|xox[baprs]-[0-9A-Za-z-]{10,}|sk_live_[0-9A-Za-z]{16,}|AIza[0-9A-Za-z_-]{35}'
ASSIGN='(JWT_SECRET|DATA_ENCRYPTION_KEY|POSTGRES_PASSWORD|APP_DB_PASSWORD|ALERT_WEBHOOK|VAPID_PRIVATE_KEY|RCLONE_CONFIG_[A-Z0-9_]*KEY|BACKUP_AGE_IDENTITY)=[A-Za-z0-9+/=_:.@%-]{16,}'
PLACEHOLDER='(REPLACE|CHANGE|EXAMPLE|PLACEHOLDER|YOUR|XXXX|\$\{|\$\(|<|=/)' # =/ : a file path, not a value

hits=0
scan() { # reads "label:content" lines on stdin
  local line
  while IFS= read -r line; do
    grep -qE "$ALLOW" <<<"$line" && continue
    if grep -qE "$HARD" <<<"$line"; then
      echo "SECRET? $line" | cut -c1-200
      hits=$((hits + 1))
    elif grep -qE "$ASSIGN" <<<"$line" && ! grep -qiE "$PLACEHOLDER" <<<"$line"; then
      echo "SECRET? $line" | cut -c1-200
      hits=$((hits + 1))
    fi
  done
}

echo "== tracked files"
scan < <(git grep -nIE "$HARD|$ASSIGN" -- . ':!pnpm-lock.yaml' ':!scripts/check-secrets.sh' || true)

echo "== git history (added lines)"
scan < <(git log --all -p --no-color --format='commit %h' -- . ':!pnpm-lock.yaml' ':!scripts/check-secrets.sh' |
  awk '/^commit /{c=$2} /^\+[^+]/{print c ": " substr($0,2)}' | { grep -E "$HARD|$ASSIGN" || true; })

if [ "$hits" -gt 0 ]; then
  echo "Found $hits possible secret(s). If one is real: rotate it first, then remove it from the code." >&2
  exit 1
fi
echo "No secrets found in the tracked files or the git history."
