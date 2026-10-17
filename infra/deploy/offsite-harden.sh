#!/usr/bin/env bash
# One-time: replaces the Backblaze key on this server with one that can write, list and read files but can NOT delete them,
# so anybody who gets into the server (or ransomware on it) cannot erase the off-server copies. Old files leave the bucket only
# through the bucket's own Lifecycle rule, which Backblaze runs, not this server.
#   sudo bash infra/deploy/offsite-harden.sh
# You type your Backblaze MASTER application key once (hidden). It is used for four API calls and never written anywhere.
# The new key is tested BEFORE it replaces the old one: it must upload, list and read, and a delete must be refused.
set -euo pipefail

die() { echo "$*" >&2; exit 1; }
if [ "$(id -u)" -ne 0 ] && [ -z "${TK_ALLOW_NONROOT:-}" ]; then die "Run with sudo: sudo bash infra/deploy/offsite-harden.sh"; fi

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CONF=${TK_BACKUP_ENV:-/etc/timekeeper-backup.env}
API=${B2_API:-https://api.backblazeb2.com}
CAPABILITIES='["listBuckets","listFiles","readFiles","writeFiles"]' # deliberately no deleteFiles, writeKeys or listKeys
[ -f "$CONF" ] || die "Missing $CONF. Run offsite-setup.sh first."
# shellcheck disable=SC1090
. "$CONF"
[ -n "${BACKUP_REMOTE:-}" ] && [ -n "${RCLONE_CONFIG:-}" ] || die "The off-server copy is not set up yet. Run offsite-setup.sh first."
[ -f "$RCLONE_CONFIG" ] || die "Missing $RCLONE_CONFIG."
bucket=${BACKUP_REMOTE#b2:}
bucket=${bucket%%/*}

if ! command -v jq >/dev/null 2>&1; then
  apt-get install -y -qq jq
fi
if ! command -v rclone >/dev/null 2>&1; then
  die "rclone is missing. Run offsite-setup.sh first."
fi

echo "Bucket: $bucket"
echo "Open Backblaze > Account > Application Keys > Master Application Key > Generate New Master Application Key (or use the one you have)."
read -r -p "Master keyID: " master_id
read -r -s -p "Master applicationKey (typing is hidden): " master_key
echo
[ -n "$master_id" ] && [ -n "$master_key" ] || die "Both are needed."

# The master key goes to curl through stdin, so it never appears in the process list.
b2_auth() { printf 'user = "%s:%s"\n' "$master_id" "$master_key" | curl -sS -K - "$API/b2api/v3/b2_authorize_account"; }
b2_post() { # b2_post <endpoint> <json body> [api version, default v3]
  printf 'header = "Authorization: %s"\n' "$token" | curl -sS -K - -X POST -d "$2" "$api_url/b2api/${3:-v3}/$1"
}
failed() { jq -e '.status != null and .status >= 400' >/dev/null 2>&1 <<<"$1"; }
reason() { jq -r '.message // "unknown error"' <<<"$1" 2>/dev/null || echo "unreadable answer"; }

echo "== signing in to Backblaze"
resp=$(b2_auth) || die "Could not reach Backblaze."
failed "$resp" && die "Backblaze refused the master key: $(reason "$resp")"
token=$(jq -r '.authorizationToken // empty' <<<"$resp")
account=$(jq -r '.accountId // empty' <<<"$resp")
api_url=$(jq -r '.apiInfo.storageApi.apiUrl // empty' <<<"$resp")
unset master_key
[ -n "$token" ] && [ -n "$account" ] && [ -n "$api_url" ] || die "Unexpected answer from Backblaze (no token). Nothing was changed."

resp=$(b2_post b2_list_buckets "$(jq -nc --arg a "$account" --arg b "$bucket" '{accountId: $a, bucketName: $b}')") || die "Could not reach Backblaze."
failed "$resp" && die "Could not look up the bucket: $(reason "$resp")"
bucket_id=$(jq -r '.buckets[0].bucketId // empty' <<<"$resp")
[ -n "$bucket_id" ] || die "Bucket \"$bucket\" was not found in this account. Nothing was changed."

echo "== creating a key that cannot delete"
key_name="tk-upload-only-$(date +%Y%m%d%H%M%S)"
# Backblaze serves b2_create_key on different API versions with different bucket fields (one bucketId, or a bucketIds list);
# try each until one accepts it. Nothing is created by a refused call.
resp=""
created_version=v3
for version in v3 v4 v2; do
  if [ "$version" = v4 ]; then
    body=$(jq -nc --arg a "$account" --arg n "$key_name" --arg b "$bucket_id" --argjson c "$CAPABILITIES" \
      '{accountId: $a, keyName: $n, capabilities: $c, bucketIds: [$b]}')
  else
    body=$(jq -nc --arg a "$account" --arg n "$key_name" --arg b "$bucket_id" --argjson c "$CAPABILITIES" \
      '{accountId: $a, keyName: $n, capabilities: $c, bucketId: $b}')
  fi
  resp=$(b2_post b2_create_key "$body" "$version") || die "Could not reach Backblaze."
  if ! failed "$resp"; then
    created_version=$version
    break
  fi
  case "$(reason "$resp")" in
    *"not currently supported"* | *"not supported"* | *"Unsupported"* | *"unsupported"*) continue ;;
    *) break ;;
  esac
done
failed "$resp" && die "Backblaze did not create the key: $(reason "$resp")"
new_id=$(jq -r '.applicationKeyId // empty' <<<"$resp")
new_key=$(jq -r '.applicationKey // empty' <<<"$resp")
[ -n "$new_id" ] && [ -n "$new_key" ] || die "Unexpected answer from Backblaze (no key). Nothing was changed."

remove_new_key() {
  local answer
  answer=$(b2_post b2_delete_key "$(jq -nc --arg k "$new_id" '{applicationKeyId: $k}')" "$created_version" 2>/dev/null) || answer=""
  if failed "$answer" || [ -z "$answer" ]; then
    echo "Note: could not remove the test key \"$key_name\" automatically. Delete it in Backblaze (Application Keys)." >&2
  fi
}

tmp=$(mktemp)
umask 077
cat >"$tmp" <<RC
[b2]
type = b2
account = $new_id
key = $new_key
RC
unset new_key
chmod 600 "$tmp"
RCLONE=(rclone --config "$tmp")

echo "== testing the new key (it must upload, list and read, and must NOT delete)"
probe="harden-test-$(date +%s)"
text="timekeeper upload-only test"
if ! echo "$text" | "${RCLONE[@]}" rcat "b2:$bucket/test/$probe"; then
  remove_new_key
  rm -f "$tmp"
  die "The new key could not upload. Nothing was changed and the new key was removed."
fi
if [ "$("${RCLONE[@]}" cat "b2:$bucket/test/$probe")" != "$text" ] || ! "${RCLONE[@]}" lsf "b2:$bucket/test/" >/dev/null; then
  remove_new_key
  rm -f "$tmp"
  die "The new key could not read or list. Nothing was changed and the new key was removed."
fi
if "${RCLONE[@]}" deletefile "b2:$bucket/test/$probe" 2>/dev/null; then
  remove_new_key
  rm -f "$tmp"
  die "The new key CAN delete files, so it is not safe. Nothing was changed and the new key was removed."
fi
echo "Good: it uploads, lists and reads, and deleting is refused."

echo "== switching the server to the new key"
prev="$RCLONE_CONFIG.prev"
cp -p "$RCLONE_CONFIG" "$prev"
cp "$tmp" "$RCLONE_CONFIG"
chmod 600 "$RCLONE_CONFIG"
rm -f "$tmp"
if ! bash "$ROOT/infra/deploy/offsite-sync.sh" recent; then
  cp "$prev" "$RCLONE_CONFIG"
  shred -u "$prev" 2>/dev/null || rm -f "$prev"
  remove_new_key
  die "The regular copy failed with the new key. The old key is back in place and the new key was removed."
fi
shred -u "$prev" 2>/dev/null || rm -f "$prev"

cat <<DONE

Done. This server now holds a key that cannot delete files (name: $key_name).

Two things left to do in the Backblaze web page:
  1. Application Keys: delete the OLD key (the one without "tk-upload-only" in its name). Until then it still works and can delete.
  2. If you generated a new master key just for this, nothing more is needed. If you used your existing master key, generate a new
     Master Application Key now (this cancels the one you typed) and keep it somewhere safe, away from this server.
Old backups are removed by the bucket's Lifecycle Settings, not by this server. Check them: Buckets > your bucket > Lifecycle Settings.
DONE
