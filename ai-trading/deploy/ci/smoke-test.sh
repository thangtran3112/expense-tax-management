#!/usr/bin/env bash
# Smoke-tests locally loaded ai-trading images.
# Usage: ai-trading/deploy/ci/smoke-test.sh [web|ta-terminal|ahf-terminal|vibe-trading|all]
# REGISTRY and TAG select the images (same defaults as docker-bake.hcl).
set -Eeuo pipefail

REGISTRY="${REGISTRY:-ghcr.io/thangtran3112/family-app}"
TAG="${TAG:-local}"
ACCESS_HEADER="Cf-Access-Authenticated-User-Email: smoke@example.test"
containers=()

cleanup() {
  if ((${#containers[@]})); then
    docker rm -f "${containers[@]}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

image() { echo "${REGISTRY}/ai-trading-$1:${TAG}"; }

# start NAME IMAGE HOST_PORT CONTAINER_PORT [extra docker run arguments...]
start() {
  local name="$1" img="$2" host_port="$3" container_port="$4"
  shift 4
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" -p "127.0.0.1:${host_port}:${container_port}" "$@" "$img" >/dev/null
  containers+=("$name")
}

# expect_status CODE URL [curl arguments...]; retries for WAIT_SECONDS (default 60).
expect_status() {
  local want="$1" url="$2" got=""
  shift 2
  local deadline=$((SECONDS + ${WAIT_SECONDS:-60}))
  while ((SECONDS < deadline)); do
    got="$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" || true)"
    if [[ "$got" == "$want" ]]; then
      echo "ok   $want $url"
      return 0
    fi
    sleep 2
  done
  fail "expected $want from $url, got ${got:-no response}"
}

# expect_body TEXT URL: the page must contain TEXT.
expect_body() {
  curl -fsS "$2" | grep -qF "$1" || fail "$2 does not contain $1"
  echo "ok   $2 contains $1"
}

# tmux runs a multi-argument command without the shell, and the config loads.
tmux_probe() {
  docker run --rm --entrypoint sh "$1" -c '
    set -e
    tmux -f /etc/ai-trading/tmux.conf new-session -d -s probe env sleep 30
    sleep 1
    tmux has-session -t probe
    test "$(tmux show-options -gv status)" = off' || fail "tmux probe failed for $1"
  echo "ok   tmux probe $1"
}

smoke_web() {
  start smoke-web "$(image web)" 13000 3000
  expect_status 200 http://127.0.0.1:13000/
  expect_status 200 http://127.0.0.1:13000/apps/tradingagents
  expect_status 200 http://127.0.0.1:13000/apps/ai-hedge-fund
  expect_status 200 http://127.0.0.1:13000/apps/vibe-trading
  expect_status 404 http://127.0.0.1:13000/apps/desk
  expect_status 404 http://127.0.0.1:13000/apps/unknown
  expect_body "/u/tradingagents/" http://127.0.0.1:13000/apps/tradingagents
  expect_body "/u/ai-hedge-fund/" http://127.0.0.1:13000/apps/ai-hedge-fund
}

# smoke_terminal SERVICE CLI BASE_PATH HOST_PORT
smoke_terminal() {
  local service="$1" cli="$2" base="$3" port="$4" img
  img="$(image "$service")"
  docker run --rm --entrypoint "$cli" "$img" --help >/dev/null || fail "$cli --help failed"
  echo "ok   $cli --help"
  tmux_probe "$img"
  start "smoke-$service" "$img" "$port" 7681
  expect_status 407 "http://127.0.0.1:${port}${base}/"
  expect_status 200 "http://127.0.0.1:${port}${base}/" -H "$ACCESS_HEADER"
  expect_status 302 "http://127.0.0.1:${port}${base}" -H "$ACCESS_HEADER"
}

smoke_vibe() {
  local url=http://127.0.0.1:18899/auth/sse-ticket
  local site=(-X POST -H "Origin: https://vibe.example.test" -H "Host: vibe.example.test")
  start smoke-vibe "$(image vibe-trading)" 18899 8899 \
    -e API_AUTH_KEY=smoke-key -e "FORWARDED_ALLOW_IPS=*" \
    --read-only --tmpfs /tmp --tmpfs /home/vibe/.cache --tmpfs /home/vibe/.config \
    -v /app/agent/runs -v /app/agent/sessions -v /app/agent/uploads -v /app/agent/.swarm/runs -v /home/vibe/.vibe-trading \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true
  WAIT_SECONDS=240 expect_status 200 http://127.0.0.1:18899/live
  # Behind the TLS tunnel: its own UI's POST is accepted ...
  expect_status 200 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key" -H "X-Forwarded-Proto: https"
  # ... without the forwarded scheme the same-site check rejects it ...
  expect_status 403 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key"
  # ... and a wrong key is refused.
  expect_status 401 "$url" "${site[@]}" -H "Authorization: Bearer wrong-key" -H "X-Forwarded-Proto: https"
}

case "${1:-all}" in
  web) smoke_web ;;
  ta-terminal) smoke_terminal ta-terminal tradingagents /u/tradingagents 17681 ;;
  ahf-terminal) smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682 ;;
  vibe-trading) smoke_vibe ;;
  all)
    smoke_web
    smoke_terminal ta-terminal tradingagents /u/tradingagents 17681
    smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682
    smoke_vibe
    ;;
  *)
    echo "usage: $0 [web|ta-terminal|ahf-terminal|vibe-trading|all]" >&2
    exit 2
    ;;
esac
echo "smoke tests passed: ${1:-all}"
