#!/bin/sh
# Runs APP_COMMAND inside a tmux session named after the signed-in user, so a
# dropped connection (iPad sleep, network blip) reattaches to the running app.
# ttyd passes the gateway-verified email in TTYD_USER (truncated to 29 chars).
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
if [ "${1:-}" = "--run-app" ]; then
  # Ctrl+C interrupts the child, not the captive launcher; child signals reset.
  trap ':' INT
  while :; do
    status=0
    "$APP_COMMAND" || status=$?
    # A crashed full-screen CLI can leave raw input mode behind.
    stty sane
    if [ "$status" -eq 0 ]; then
      printf '\nAnalysis finished.\n'
    else
      printf '\nApp exited with status %s. Previous output is kept above.\n' "$status"
    fi
    printf 'Press Enter to start another analysis: '
    IFS= read -r _ || exit 0
  done
fi

name=$(session_name "${TTYD_USER:-}")
# Two or more arguments make tmux exec the command directly, without a shell.
exec tmux -f /etc/ai-trading/tmux.conf new-session -A -s "$name" sh "$0" --run-app
