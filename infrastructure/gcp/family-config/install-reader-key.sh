#!/usr/bin/env bash
# Installs or rotates the VPS key for family-config-reader at
# /etc/family-app/config-reader.json. The new key streams from gcloud straight
# into the VPS and never touches the local disk. Older keys are deleted only
# after the VPS reads Firestore with the new one.
# Usage: infrastructure/gcp/family-config/install-reader-key.sh
set -Eeuo pipefail
umask 077

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CLI="$ROOT/common/config/family_config.py"
PROJECT="${FAMILY_CONFIG_PROJECT:-tobytran-portfolio}"
CONFIGURATION="${FAMILY_CONFIG_GCLOUD_CONFIG:-personal}"
READER_EMAIL="family-config-reader@$PROJECT.iam.gserviceaccount.com"
REMOTE_KEY=/etc/family-app/config-reader.json

# Re-run under with-file so the operator SSH key exists only as a temp file.
if [[ "${1:-}" != "--ssh-key" ]]; then
  exec "$CLI" with-file shared/vps VPS_OPERATOR_SSH_PRIVATE_KEY -- "$0" --ssh-key {}
fi
ssh_key="$2"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
host="$("$CLI" get shared/vps VPS_HOST)"
port="$("$CLI" get shared/vps VPS_PORT)"
user="$("$CLI" get shared/vps VPS_USER)"
"$CLI" get shared/vps VPS_SSH_KNOWN_HOSTS >"$work/known_hosts"
common_opts=(-i "$ssh_key" -o IdentitiesOnly=yes -o BatchMode=yes -o UserKnownHostsFile="$work/known_hosts" -o StrictHostKeyChecking=yes)
ssh_opts=("${common_opts[@]}" -p "$port")
scp_opts=("${common_opts[@]}" -P "$port")
target="$user@$host"
g() { gcloud --configuration="$CONFIGURATION" --project="$PROJECT" "$@"; }

old_keys="$(g iam service-accounts keys list --iam-account="$READER_EMAIL" --managed-by=user --format='value(name.basename())')"

g iam service-accounts keys create /dev/stdout --iam-account="$READER_EMAIL" |
  ssh "${ssh_opts[@]}" "$target" \
    "sudo sh -c 'umask 077 && install -d -m 0755 /etc/family-app && cat > /etc/family-app/.config-reader.json.new && mv -f /etc/family-app/.config-reader.json.new $REMOTE_KEY'"
echo "installed new reader key at $host:$REMOTE_KEY"

remote_dir="/tmp/family-config-verify-$$"
ssh "${ssh_opts[@]}" "$target" "install -d -m 0700 $remote_dir"
scp "${scp_opts[@]}" "$CLI" "$target:$remote_dir/family_config.py"
ssh "${ssh_opts[@]}" "$target" \
  "trap 'rm -rf $remote_dir' EXIT; sudo env FAMILY_CONFIG_CREDENTIALS=$REMOTE_KEY python3 $remote_dir/family_config.py keys expense-tax-management/production >/dev/null"
echo "verified Firestore reads on $host with the new key"

for key_id in $old_keys; do
  g iam service-accounts keys delete "$key_id" --iam-account="$READER_EMAIL" --quiet
  echo "deleted old reader key $key_id"
done
