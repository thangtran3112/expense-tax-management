#!/bin/sh
# Starts ttyd for one upstream terminal app.
#   APP_COMMAND       command run inside the per-user tmux session (required)
#   TTYD_BASE_PATH    URL prefix served by ttyd, for example /u/tradingagents (required)
#   TTYD_AUTH_HEADER  request header carrying the signed-in user (optional)
set -eu
: "${APP_COMMAND:?APP_COMMAND is required}"
: "${TTYD_BASE_PATH:?TTYD_BASE_PATH is required}"
set -- --port 7681 --writable --check-origin --base-path "$TTYD_BASE_PATH" --terminal-type xterm-256color
if [ -n "${TTYD_AUTH_HEADER:-}" ]; then
  set -- "$@" --auth-header "$TTYD_AUTH_HEADER"
fi
exec /usr/local/bin/ttyd "$@" /usr/local/bin/session.sh
