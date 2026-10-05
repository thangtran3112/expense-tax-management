#!/bin/sh
# Runs APP_COMMAND inside a tmux session named after the signed-in user, so a
# dropped connection (iPad sleep, network blip) reattaches to the running app.
# ttyd passes the Cloudflare Access email in TTYD_USER (truncated to 29 chars).
set -eu

session_name() {
  name=$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | cut -c1-32)
  case "$name" in
    *[a-z0-9]*) printf '%s\n' "$name" ;;
    *) printf '%s\n' default ;;
  esac
}

if [ "${1:-}" = "--print-name" ]; then
  session_name "${2:-}"
  exit 0
fi

: "${APP_COMMAND:?APP_COMMAND is required}"
name=$(session_name "${TTYD_USER:-}")
# Two or more arguments make tmux exec the command directly, without a shell.
exec tmux -f /etc/ai-trading/tmux.conf new-session -A -s "$name" env "$APP_COMMAND"
