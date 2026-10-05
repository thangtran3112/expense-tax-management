#!/usr/bin/env bash
# Installs the ai-trading env files from a local secrets bundle onto the host.
# Usage: write-secrets.sh --host HOST --port PORT --user USER --key SSH_KEY --bundle-dir DIR
# The bundle holds tradingagents.env, ai-hedge-fund.env, vibe-trading.env, and
# cloudflared.env. They are installed as root:root 0600 in /etc/family-app/ai-trading/.
set -Eeuo pipefail
umask 077

usage() {
  sed -n '2,5p' "$0" >&2
  exit 2
}

HOST="" PORT="" USER_NAME="" KEY="" BUNDLE=""
while (($#)); do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --user) USER_NAME="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --bundle-dir) BUNDLE="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$HOST" && -n "$PORT" && -n "$USER_NAME" && -n "$KEY" && -n "$BUNDLE" ]] || usage

FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env cloudflared.env)
for name in "${FILES[@]}"; do
  file="$BUNDLE/$name"
  [[ -f "$file" ]] || { echo "missing $file" >&2; exit 1; }
  # Empty or placeholder values would override app defaults or saved keys.
  if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=(replace-me)?$' "$file"; then
    echo "$file has empty or replace-me values; delete unused keys instead" >&2
    exit 1
  fi
done

ssh_cmd=(ssh -i "$KEY" -p "$PORT" -o StrictHostKeyChecking=yes "$USER_NAME@$HOST")
stage="/tmp/ai-trading-secrets-$$"
"${ssh_cmd[@]}" "install -d -m 0700 '$stage'"
scp -i "$KEY" -P "$PORT" -o StrictHostKeyChecking=yes "${FILES[@]/#/$BUNDLE/}" "$USER_NAME@$HOST:$stage/"
"${ssh_cmd[@]}" "set -e; trap 'rm -rf $stage' EXIT; sudo install -d -o root -g root -m 0700 /etc/family-app/ai-trading; for f in ${FILES[*]}; do sudo install -o root -g root -m 0600 '$stage'/\$f /etc/family-app/ai-trading/\$f; done"
echo "installed ${#FILES[@]} env files into /etc/family-app/ai-trading on $HOST"
