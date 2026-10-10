#!/usr/bin/env bash
# Smoke-tests locally loaded ai-trading images.
# Usage: ai-trading/deploy/ci/smoke-test.sh [web|ta-terminal|ahf-terminal|vibe-trading|mirofish-backend|mirofish|gateway|all]
# REGISTRY and TAG select the images (same defaults as docker-bake.hcl).
set -Eeuo pipefail

REGISTRY="${REGISTRY:-ghcr.io/thangtran3112/family-app}"
TAG="${TAG:-local}"
ACCESS_HEADER="Cf-Access-Authenticated-User-Email: smoke@example.test"
VIBE_OPENAI_ENV=(-e LANGCHAIN_PROVIDER=openai -e LANGCHAIN_MODEL_NAME=gpt-5.5
  -e OPENAI_BASE_URL=https://api.openai.com/v1 -e OPENAI_API_KEY=sk-smoke-openai-dummy
  -e LANGCHAIN_REASONING_EFFORT=none
  -e VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=1)
containers=()

cleanup() {
  if ((${#containers[@]})); then
    docker rm -fv "${containers[@]}" >/dev/null 2>&1 || true
  fi
  docker network rm smoke-gateway-net >/dev/null 2>&1 || true
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
    got="$(curl -s --connect-timeout 5 --max-time 10 -o /dev/null -w '%{http_code}' "$@" "$url" || true)"
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
  curl -fsS --connect-timeout 5 --max-time 10 "$2" | grep -qF "$1" || fail "$2 does not contain $1"
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
  local headers
  headers="$(curl -fsSI http://127.0.0.1:13000/)"
  grep -qi '^cache-control: no-store' <<<"$headers" || fail "expected no-store Cache-Control on /"
  grep -qi '^x-frame-options: DENY' <<<"$headers" || fail "expected X-Frame-Options on /"
}

# smoke_terminal SERVICE CLI BASE_PATH HOST_PORT
smoke_terminal() {
  local service="$1" cli="$2" base="$3" port="$4" img
  img="$(image "$service")"
  docker run --rm --entrypoint "$cli" "$img" --help >/dev/null || fail "$cli --help failed"
  echo "ok   $cli --help"
  tmux_probe "$img"
  docker run --rm --network none --entrypoint python \
    -v "$PWD/ai-trading/deploy/upstream/terminal/test-session-lifecycle.py:/checks/test-session-lifecycle.py:ro" \
    "$img" /checks/test-session-lifecycle.py || fail "terminal lifecycle failed for $service"
  start "smoke-$service" "$img" "$port" 7681
  expect_status 407 "http://127.0.0.1:${port}${base}/"
  expect_status 200 "http://127.0.0.1:${port}${base}/" -H "$ACCESS_HEADER"
  expect_status 302 "http://127.0.0.1:${port}${base}" -H "$ACCESS_HEADER"
}

smoke_vibe() {
  docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" \
    "$(image vibe-trading)" -c '
from langchain_openai import ChatOpenAI
from src.providers.llm import build_llm
client=build_llm()
assert isinstance(client, ChatOpenAI)
assert client.openai_api_base=="https://api.openai.com/v1"
' || fail "Vibe-Trading direct OpenAI adapter could not be constructed"
  echo "ok   Vibe-Trading constructs its direct OpenAI adapter offline"
  local rejected
  # Value: protects=fail-closed boot for a complete direct OpenAI profile;
  # fails_when=any required provider/model/key/secure-mode guard is removed;
  # why_new=existing negative cases covered only provider and endpoint; seam=none.
  for rejected in LANGCHAIN_PROVIDER=openrouter OPENAI_BASE_URL=https://openrouter.ai/api/v1 \
    LANGCHAIN_MODEL_NAME= OPENAI_API_KEY= VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=0; do
    local rejection
    if rejection="$(docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" \
      -e "$rejected" "$(image vibe-trading)" /usr/local/bin/start-vibe.py \
      python -c 'raise SystemExit(0)' 2>&1)"; then
      fail "Vibe startup accepted an incomplete/non-OpenAI profile override ($rejected)"
    fi
    grep -qF 'Vibe requires the direct OpenAI family-config profile' <<<"$rejection" \
      || fail "Vibe startup failed for a reason other than the provider policy ($rejected)"
  done
  echo "ok   Vibe startup refuses OpenRouter, missing model/key, and disabled secure-credentials overrides"
  # Value: protects=stale provider credentials are cleared on a volume-backed redeploy;
  # fails_when=settings upsert or stale credential clearing is removed;
  # why_new=the normal boot test starts with an empty settings volume; seam=none.
  docker run --rm --network none --entrypoint python "${VIBE_OPENAI_ENV[@]}" "$(image vibe-trading)" -c '
import os, pathlib, sys
d = pathlib.Path.home() / ".vibe-trading"
d.mkdir(parents=True, exist_ok=True)
(d / ".env").write_text(
    "LANGCHAIN_PROVIDER=openrouter\n"
    "LANGCHAIN_MODEL_NAME=deepseek/deepseek-v4-pro\n"
    "OPENROUTER_BASE_URL=https://openrouter.ai/api/v1\n"
    "OPENROUTER_API_KEY=sk-or-v1-stale-dummy-router-key\n"
    "ANTHROPIC_API_KEY=sk-ant-stale-dummy-anthropic-key\n"
    "TUSHARE_TOKEN=stale-dummy-tushare-token\n"
    "LANGCHAIN_REASONING_EFFORT=high\n"
    "LANGCHAIN_TEMPERATURE=0.9\n"
    "MAX_RETRIES=9\n"
)
check = """
import os, pathlib, stat
from src.api.helpers import _read_env_values
path = pathlib.Path.home() / ".vibe-trading" / ".env"
values = _read_env_values(path)
assert values["LANGCHAIN_PROVIDER"] == "openai"
assert values["LANGCHAIN_MODEL_NAME"] == "gpt-5.5"
assert values["OPENAI_BASE_URL"] == "https://api.openai.com/v1"
assert values["LANGCHAIN_REASONING_EFFORT"] == "none"
for name in ("OPENROUTER_BASE_URL", "OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "TUSHARE_TOKEN"):
    assert values.get(name, "") == "", name + " was not cleared"
assert values["LANGCHAIN_TEMPERATURE"] == "0.9"
assert values["MAX_RETRIES"] == "9"
assert stat.S_IMODE(path.stat().st_mode) == 0o600
assert os.environ["OPENAI_API_KEY"] == "sk-smoke-openai-dummy"
"""
os.execvp(sys.executable, [sys.executable, "/usr/local/bin/start-vibe.py", sys.executable, "-c", check])
' || fail "Vibe did not overwrite a stale persisted .env (old provider/keys/endpoint) while preserving unrelated settings"
  echo "ok   Vibe overwrites a stale persisted .env without wiping its unrelated settings"
  # Retain native Anthropic compatibility. Construct its actual adapter
  # with a fake key and no network; liveness alone misses absent extras.
  docker run --rm --network none --entrypoint python \
    -v "$PWD/ai-trading/packages/vibe-trading/requirements-lock.txt:/expected-base-requirements.txt:ro" \
    -e ANTHROPIC_API_KEY=sk-ant-smoke-dummy -e LANGCHAIN_PROVIDER=anthropic \
    -e LANGCHAIN_MODEL_NAME=claude-sonnet-5-5 "$(image vibe-trading)" -c '
import importlib.metadata as metadata
import re
from pathlib import Path
# Optional provider installation must not upgrade upstream hash-locked packages.
for line in Path("/expected-base-requirements.txt").read_text().splitlines():
    pin = re.match(r"^([A-Za-z0-9_.-]+)==([^ ;\\]+)", line)
    if not pin:
        continue
    name, expected = pin.groups()
    try:
        actual = metadata.version(name)
    except metadata.PackageNotFoundError:
        continue  # platform-specific packages may be absent from this image
    assert actual == expected, f"{name} changed from upstream {expected} to {actual}"
from langchain_anthropic import ChatAnthropic
from src.providers.llm import build_llm
assert isinstance(build_llm(), ChatAnthropic)
' || fail "Vibe-Trading native Anthropic adapter could not be constructed"
  echo "ok   Vibe-Trading constructs its native Anthropic adapter offline"
  local url=http://127.0.0.1:18899/auth/sse-ticket
  local site=(-X POST -H "Origin: https://vibe.example.test" -H "Host: vibe.example.test")
  start smoke-vibe "$(image vibe-trading)" 18899 8899 \
    -e API_AUTH_KEY=smoke-key -e "FORWARDED_ALLOW_IPS=*" \
    "${VIBE_OPENAI_ENV[@]}" \
    --read-only --tmpfs /tmp --tmpfs /home/vibe/.cache --tmpfs /home/vibe/.config \
    -v /app/agent/runs -v /app/agent/sessions -v /app/agent/uploads -v /app/agent/.swarm/runs -v /home/vibe/.vibe-trading \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true
  WAIT_SECONDS=240 expect_status 200 http://127.0.0.1:18899/live
  curl -fsS -H 'Authorization: Bearer smoke-key' http://127.0.0.1:18899/settings/llm | python3 -c '
import json,sys
settings=json.load(sys.stdin)
assert settings["provider"]=="openai", "Settings fell back to the upstream example provider"
assert settings["model_name"]=="gpt-5.5"
assert settings["base_url"]=="https://api.openai.com/v1"
assert settings["api_key_configured"] is True
assert settings["reasoning_effort"]=="none"
assert "sk-smoke-openai-dummy" not in json.dumps(settings)
' || fail "Vibe settings do not reflect the injected OpenAI configuration"
  docker exec smoke-vibe python -c '
import pathlib,stat
path=pathlib.Path.home()/".vibe-trading"/".env"
assert stat.S_IMODE(path.stat().st_mode)==0o600
assert "sk-smoke-openai-dummy" not in path.read_text(), "Provider key was copied into settings"
' || fail "Vibe settings must be private and contain no copied provider key"
  echo "ok   Vibe settings match direct OpenAI without copying/exposing its key"
  # Behind the TLS tunnel: its own UI's POST is accepted ...
  expect_status 200 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key" -H "X-Forwarded-Proto: https"
  # ... without the forwarded scheme the same-site check rejects it ...
  expect_status 403 "$url" "${site[@]}" -H "Authorization: Bearer smoke-key"
  # ... a cross-site Origin is rejected even with the forwarded scheme and the right key ...
  expect_status 403 "$url" -X POST -H "Origin: https://evil.example.test" -H "Host: vibe.example.test" \
    -H "Authorization: Bearer smoke-key" -H "X-Forwarded-Proto: https"
  # ... and a wrong key is refused.
  expect_status 401 "$url" "${site[@]}" -H "Authorization: Bearer wrong-key" -H "X-Forwarded-Proto: https"
}

# smoke_mirofish_backend: dummy, non-secret keys only, no real Zep/LLM call.
# This never signals "the simulation engine works" (Review Focus #1).
smoke_mirofish_backend() {
  start smoke-mirofish-backend "$(image mirofish-backend)" 15001 5001 \
    -e LLM_API_KEY=sk-smoke-dummy -e ZEP_API_KEY=z_smoke-dummy
  expect_status 200 http://127.0.0.1:15001/health
  expect_body '"status":"ok"' http://127.0.0.1:15001/health
  expect_body '"service":"MiroFish Backend"' http://127.0.0.1:15001/health
}

# smoke_mirofish_frontend: the real `docker buildx bake mirofish-frontend`
# export output (ai-trading/frontend-artifacts/mirofish), not a container.
# Checks the static Vue build is present, content-hashed, and built with a
# real VITE_API_BASE_URL (no leftover localhost:5001 dev default).
smoke_mirofish_frontend() {
  local dir="ai-trading/frontend-artifacts/mirofish"
  [[ -f "$dir/index.html" ]] || fail "$dir/index.html missing -- run docker buildx bake mirofish-frontend first"
  grep -qE 'assets/index-[A-Za-z0-9_-]+\.js' "$dir/index.html" || fail "$dir/index.html does not reference a content-hashed assets/index-*.js bundle"
  compgen -G "$dir/assets/index-*.js" >/dev/null || fail "$dir/assets has no hashed index-*.js bundle"
  if grep -qF "localhost:5001" -r "$dir"; then
    fail "mirofish static build still references localhost:5001"
  fi
  echo "ok   mirofish static build has no localhost:5001 reference"
}

# sign_smoke_cookie KEY_HEX EMAIL EXP_OFFSET_SECONDS: signs a cookie value
# with the same HMAC scheme as ai-trading/auth/src/session.js, using only
# Node (already a dependency of this script's own checks elsewhere), so this
# test needs no extra tooling beyond Docker.
sign_smoke_cookie() {
  docker run --rm node:24-alpine node -e '
const { createHmac } = require("node:crypto");
const key = Buffer.from(process.argv[1], "hex");
const payload = JSON.stringify({ email: process.argv[2], exp: Math.floor(Date.now() / 1000) + Number(process.argv[3]) });
const body = Buffer.from(payload).toString("base64url");
const mac = createHmac("sha256", key).update(body).digest("base64url");
process.stdout.write(`__ai_trading_session=${body}.${mac}`);
' "$1" "$2" "$3"
}

smoke_gateway() {
  local net="smoke-gateway-net" key
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  key="$(printf 'a%.0s' {1..64})"

  docker run -d --name smoke-auth --network "$net" --network-alias auth \
    -e SESSION_SIGNING_KEY="$key" -e ALLOWED_EMAILS=smoke@example.test \
    -e ALLOWED_ORIGINS=https://trading.example.test \
    "$(image auth)" >/dev/null
  containers+=(smoke-auth)

  # Header-echo stand-in for ta-terminal: returns whatever it received as
  # Cf-Access-Authenticated-User-Email, so the test can prove Caddy replaced
  # a forged value before any upstream ever saw it. No WebSocket code here --
  # this container is swapped for a real ttyd image below for that check.
  docker run -d --name smoke-echo-upstream --network "$net" --network-alias ta-terminal \
    python:3.12-alpine python3 -c '
import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.headers.get("Cf-Access-Authenticated-User-Email", "none").encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers()
        self.wfile.write(body)
http.server.HTTPServer(("0.0.0.0", 7681), H).serve_forever()
' >/dev/null
  containers+=(smoke-echo-upstream)

  docker run -d --name smoke-caddy --network "$net" -p 127.0.0.1:18080:8080 \
    -e VIBE_API_AUTH_KEY=smoke-key \
    -v "$PWD/ai-trading/deploy/production/Caddyfile:/etc/caddy/Caddyfile:ro" \
    caddy:2-alpine >/dev/null
  containers+=(smoke-caddy)

  local cookie expired_cookie body
  cookie="$(sign_smoke_cookie "$key" smoke@example.test 3600)"
  expired_cookie="$(sign_smoke_cookie "$key" smoke@example.test -10)"

  expect_status 401 http://127.0.0.1:18080/u/tradingagents/
  # Vibe's dedicated hostname must cross this same Clerk/Caddy gate, not
  # reach its upstream API directly through the tunnel.
  expect_status 401 http://127.0.0.1:18080/live -H 'Host: vibe-trading.tobytran.dev'
  expect_status 403 http://127.0.0.1:18080/__auth/session \
    -X POST -H 'Origin: https://evil.example.test' -H 'Content-Type: application/json' -d '{}'
  expect_status 403 http://127.0.0.1:18080/__auth/logout \
    -X POST -H 'Origin: https://evil.example.test' --cookie "$cookie"
  expect_status 405 http://127.0.0.1:18080/__auth/logout
  expect_status 204 http://127.0.0.1:18080/__auth/logout \
    -X POST -H 'Origin: https://trading.example.test' --cookie "$cookie"
  local logout_headers
  logout_headers="$(curl -s -D - -o /dev/null --cookie "$cookie" \
    -X POST -H 'Origin: https://trading.example.test' http://127.0.0.1:18080/__auth/logout)"
  grep -qi '^set-cookie: __ai_trading_session=; .*Max-Age=0' <<<"$logout_headers" || fail "Caddy did not forward the trading cookie deletion"
  echo "ok   Caddy forwards Origin-checked gateway cookie logout"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ --cookie "$expired_cookie"

  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$body" == "smoke@example.test" ]] || fail "expected the upstream to see the verified email, got: $body"
  echo "ok   Caddy replaced a spoofed Cf-Access-Authenticated-User-Email header with the verified one"

  # Terminal hostnames (01l): same gate, `/` rewritten onto ttyd's base path,
  # signed-out navigations sent to the hub login, everything else 401.
  local ta_host=(-H 'Host: tradingagents.tobytran.dev')
  local nav
  nav="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${ta_host[@]}" -H 'Sec-Fetch-Mode: navigate' http://127.0.0.1:18080/)"
  [[ "$nav" == "302 https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftradingagents.tobytran.dev%2F" ]] \
    || fail "signed-out navigation on the terminal hostname should redirect to the hub login, got: $nav"
  echo "ok   signed-out navigation on a terminal hostname redirects to the hub login"
  expect_status 401 http://127.0.0.1:18080/token "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/u/tradingagents/ "${ta_host[@]}"
  expect_status 401 http://127.0.0.1:18080/ "${ta_host[@]}" --cookie "$expired_cookie" -H 'Sec-Fetch-Mode: websocket'
  body="$(curl -s --cookie "$cookie" -H 'Cf-Access-Authenticated-User-Email: attacker@evil.com' "${ta_host[@]}" http://127.0.0.1:18080/)"
  [[ "$body" == "smoke@example.test" ]] || fail "terminal hostname: expected the verified email upstream, got: $body"
  echo "ok   terminal hostname replaces a spoofed identity header with the verified one"
  expect_status 401 http://127.0.0.1:18080/token -H 'Host: ai-hedge-fund.tobytran.dev'

  # Swap the header-echo stand-in for a real ttyd to prove the WebSocket
  # handshake actually reaches a real upstream through forward_auth + reverse_proxy.
  # "smoke-ta-terminal" also names smoke_terminal's own container (started
  # before smoke_gateway in the "all" dispatch order and still running for
  # its own trap cleanup) -- rm -f it here too, same idempotent-start guard
  # used throughout this script, so the name is free to reuse.
  docker rm -f smoke-echo-upstream smoke-ta-terminal >/dev/null 2>&1 || true
  docker run -d --name smoke-ta-terminal --network "$net" --network-alias ta-terminal "$(image ta-terminal)" >/dev/null
  containers+=(smoke-ta-terminal)
  docker restart smoke-caddy >/dev/null
  sleep 2

  local ws_status
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    http://127.0.0.1:18080/u/tradingagents/)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 Switching Protocols through Caddy to a real ttyd, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd through Caddy with a valid cookie"
  ws_status="$(curl -s -o /dev/null -w '%{http_code}' --cookie "$cookie" -H 'Host: tradingagents.tobytran.dev' \
    -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    -H 'Origin: http://tradingagents.tobytran.dev' \
    http://127.0.0.1:18080/ws)"
  [[ "$ws_status" == "101" ]] || fail "expected 101 from a real ttyd at /ws on the terminal hostname, got $ws_status"
  echo "ok   WebSocket handshake reaches a real ttyd at /ws on the terminal hostname"

  docker run -d --name smoke-vibe-gateway --network "$net" --network-alias vibe-trading \
    -e API_AUTH_KEY=smoke-key -e 'FORWARDED_ALLOW_IPS=*' \
    "${VIBE_OPENAI_ENV[@]}" \
    --read-only --tmpfs /tmp --tmpfs /home/vibe/.cache --tmpfs /home/vibe/.config \
    -v /app/agent/runs -v /app/agent/sessions -v /app/agent/uploads -v /app/agent/.swarm/runs -v /home/vibe/.vibe-trading \
    --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges:true \
    "$(image vibe-trading)" >/dev/null
  containers+=(smoke-vibe-gateway)
  local vibe_host=(-H 'Host: vibe-trading.tobytran.dev')
  WAIT_SECONDS=240 expect_status 200 http://127.0.0.1:18080/live "${vibe_host[@]}" --cookie "$cookie"
  expect_status 401 http://127.0.0.1:18080/live "${vibe_host[@]}" --cookie "$expired_cookie"
  expect_status 401 http://127.0.0.1:18080/live "${vibe_host[@]}" -H 'Cf-Access-Authenticated-User-Email: forged'
  # Caddy supplies Vibe's API key after the Clerk check: no browser key needed,
  # and a wrong browser-sent key is replaced rather than forwarded.
  expect_status 200 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" --cookie "$cookie"
  expect_status 200 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" --cookie "$cookie" \
    -H 'Authorization: Bearer wrong-key'
  expect_status 200 http://127.0.0.1:18080/auth/sse-ticket "${vibe_host[@]}" --cookie "$cookie" \
    -X POST -H 'Origin: https://vibe-trading.tobytran.dev'
  expect_status 401 http://127.0.0.1:18080/api/connections "${vibe_host[@]}" \
    -H 'Authorization: Bearer smoke-key'
  docker rm -f smoke-vibe-gateway >/dev/null

  docker network rm "$net" >/dev/null 2>&1 || true
}

smoke_market_data() {
  local net="smoke-md-net"
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  docker run -d --name smoke-market-data --network "$net" --network-alias market-data \
    -e MARKET_DATA_TOKEN=smoke-token "$(image market-data)" >/dev/null
  containers+=(smoke-market-data)
  # Real upstream FDClient, repointed by the wrapper's sitecustomize, against the
  # real service with no provider keys: earnings 501, prices 502, bad key 401.
  docker run --rm --network "$net" -e FD_BASE_URL=http://market-data:8000 -e FINANCIAL_DATASETS_API_KEY=smoke-token \
    --entrypoint python "$(image ahf-terminal)" -c '
import time, urllib.request
for _ in range(30):
    try:
        urllib.request.urlopen("http://market-data:8000/healthz", timeout=2); break
    except Exception:
        time.sleep(1)
from hedge_fund.data import FDClient, FDClientError
assert FDClient.BASE_URL == "http://market-data:8000", FDClient.BASE_URL
def status(call):
    try:
        call(); return 200
    except FDClientError as e:
        return e.status_code
fd = FDClient()
assert status(lambda: fd.get_earnings("AAPL")) == 501
assert status(lambda: fd.get_prices("AAPL", "2024-01-01", "2024-01-31")) == 502
assert status(lambda: FDClient(api_key="wrong").get_prices("AAPL", "2024-01-01", "2024-01-31")) == 401
' || fail "ai-hedge-fund FDClient against market-data"
  echo "ok   ai-hedge-fund FDClient reaches market-data: 501/502/401 contract"
  # Shape contract: our responses parse into upstream's own pydantic models
  # (server code run in-process with fake providers, inside the real ahf image).
  docker run --rm --network none -v "$PWD/ai-trading/market-data:/md:ro" -e PYTHONPATH=/md -e PYTHONDONTWRITEBYTECODE=1 \
    --entrypoint python "$(image ahf-terminal)" -c '
import threading
import server, test_metrics
from hedge_fund.data import FDClient
class P:
    def daily_bars(self, t, s, e, a):
        return [{"open": 1.0, "close": 20.0, "high": 2.0, "low": 0.5, "volume": 7, "time": "2024-04-30T04:00:00Z"}]
class F:
    def companyfacts(self, t): return test_metrics.company()
    def facts(self, t): return {"ticker": t, "name": "Example", "cik": "1", "is_active": True, "sector": "Manufacturing"}
srv = server.make_server(0, "k", P(), F())
threading.Thread(target=srv.serve_forever, daemon=True).start()
FDClient.BASE_URL = f"http://127.0.0.1:{srv.server_address[1]}"
fd = FDClient(api_key="k")
assert fd.get_prices("AAPL", "2024-04-01", "2024-04-30")[0].close == 20.0
m = fd.get_financial_metrics("AAPL", "2024-05-01", limit=2)
assert [r.report_period for r in m] == ["2024-03-31", "2023-12-31"] and m[0].market_cap == 200.0, m
assert fd.get_company_facts("AAPL").sector == "Manufacturing"
' || fail "market-data responses do not parse into upstream models"
  echo "ok   market-data prices, metrics, and facts parse into upstream models"
  docker rm -f smoke-market-data >/dev/null
  docker network rm "$net" >/dev/null 2>&1 || true
}

case "${1:-all}" in
  web) smoke_web ;;
  ta-terminal) smoke_terminal ta-terminal tradingagents /u/tradingagents 17681 ;;
  ahf-terminal) smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682 ;;
  vibe-trading) smoke_vibe ;;
  mirofish-backend) smoke_mirofish_backend ;;
  mirofish) smoke_mirofish_backend; smoke_mirofish_frontend ;;
  gateway) smoke_gateway ;;
  market-data) smoke_market_data ;;
  all)
    smoke_web
    smoke_terminal ta-terminal tradingagents /u/tradingagents 17681
    smoke_gateway
    smoke_terminal ahf-terminal aihf /u/ai-hedge-fund 17682
    smoke_market_data
    smoke_vibe
    smoke_mirofish_backend
    smoke_mirofish_frontend
    ;;
  *)
    echo "usage: $0 [web|ta-terminal|ahf-terminal|market-data|vibe-trading|mirofish-backend|mirofish|gateway|all]" >&2
    exit 2
    ;;
esac
echo "smoke tests passed: ${1:-all}"
