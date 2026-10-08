# Task 3: Image Build, Smoke Tests, Local Stack

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `ai-trading/deploy/docker-bake.hcl`, `ai-trading/deploy/docker-bake.ci.hcl`, `ai-trading/deploy/ci/**`, `ai-trading/deploy/local/**`. Do not run `git add`, `git commit`, or `git push`.

**Files:**
- Create: `ai-trading/deploy/docker-bake.hcl`, `ai-trading/deploy/docker-bake.ci.hcl`
- Create: `ai-trading/deploy/ci/smoke-test.sh`
- Create: `ai-trading/deploy/local/docker-compose.override.yml`, `ai-trading/deploy/local/Caddyfile`, `ai-trading/deploy/local/local.env`, `ai-trading/deploy/local/README.md`

**Interfaces:**
- Consumes:
  - Task 1's `ai-trading/frontend/Dockerfile`.
  - Task 2's Dockerfiles, which need named contexts `base`, `tools`, and `upstream`.
  - Task 4's `ai-trading/deploy/production/docker-compose.yml` (services and networks per Shared Interfaces).
  - Vibe-Trading facts:
    - `Authorization: Bearer <API_AUTH_KEY>`.
    - `POST /auth/sse-ticket` returns 200 with no side effects, 403 `Cross-site request denied` when the same-site check fails, and 401 for a wrong key.
    - `/live` returns 200 once startup preflight finishes.
- Produces:
  - Bake targets and variables per Shared Interfaces.
  - `smoke-test.sh`, used by Task 6's CI and by Task 7.
  - The local stack at `http://localhost:8080` (hub) and `http://localhost:8899` (Vibe-Trading).

Bake resolves relative paths against the current working directory, so every path below is relative to the repository root, and bake always runs from there.

- [ ] **Step 1: Write `ai-trading/deploy/docker-bake.hcl`**

```hcl
# Builds every ai-trading image. Run from the repository root:
#   docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
# Bake resolves relative paths against the current working directory.

variable "REGISTRY" {
  default = "ghcr.io/thangtran3112/family-app"
}

variable "TAG" {
  default = "local"
}

variable "VIBE_TRADING_URL" {
  default = "https://vibe-trading.tobytran.dev"
}

group "default" {
  targets = ["web", "ta-terminal", "ahf-terminal", "vibe-trading"]
}

target "web" {
  context = "ai-trading/frontend"
  args = {
    NEXT_PUBLIC_VIBE_TRADING_URL = VIBE_TRADING_URL
  }
  tags = ["${REGISTRY}/ai-trading-web:${TAG}"]
}

target "terminal-tools" {
  context = "ai-trading/deploy/upstream/terminal"
}

target "ta-upstream" {
  context = "ai-trading/packages/trading-agents"
}

target "ta-terminal" {
  context = "ai-trading/deploy/upstream/trading-agents"
  contexts = {
    base  = "target:ta-upstream"
    tools = "target:terminal-tools"
  }
  tags = ["${REGISTRY}/ai-trading-ta-terminal:${TAG}"]
}

target "ahf-terminal" {
  context = "ai-trading/deploy/upstream/ai-hedge-fund"
  contexts = {
    upstream = "ai-trading/packages/ai-hedge-fund"
    tools    = "target:terminal-tools"
  }
  tags = ["${REGISTRY}/ai-trading-ahf-terminal:${TAG}"]
}

target "vibe-trading" {
  context = "ai-trading/packages/vibe-trading"
  tags    = ["${REGISTRY}/ai-trading-vibe-trading:${TAG}"]
}
```

- [ ] **Step 2: Write `ai-trading/deploy/docker-bake.ci.hcl` (GitHub Actions cache, one scope per target)**

```hcl
# Merged with docker-bake.hcl in GitHub Actions: adds per-target GHA layer caches.

target "web" {
  cache-from = ["type=gha,scope=ai-trading-web"]
  cache-to   = ["type=gha,scope=ai-trading-web,mode=max"]
}

target "terminal-tools" {
  cache-from = ["type=gha,scope=ai-trading-terminal-tools"]
  cache-to   = ["type=gha,scope=ai-trading-terminal-tools,mode=max"]
}

target "ta-upstream" {
  cache-from = ["type=gha,scope=ai-trading-ta-upstream"]
  cache-to   = ["type=gha,scope=ai-trading-ta-upstream,mode=max"]
}

target "ta-terminal" {
  cache-from = ["type=gha,scope=ai-trading-ta-terminal"]
  cache-to   = ["type=gha,scope=ai-trading-ta-terminal,mode=max"]
}

target "ahf-terminal" {
  cache-from = ["type=gha,scope=ai-trading-ahf-terminal"]
  cache-to   = ["type=gha,scope=ai-trading-ahf-terminal,mode=max"]
}

target "vibe-trading" {
  cache-from = ["type=gha,scope=ai-trading-vibe-trading"]
  cache-to   = ["type=gha,scope=ai-trading-vibe-trading,mode=max"]
}
```

- [ ] **Step 3: Write `ai-trading/deploy/ci/smoke-test.sh`**

```bash
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
```

Then run `chmod +x ai-trading/deploy/ci/smoke-test.sh`.

- [ ] **Step 4: Write `ai-trading/deploy/local/Caddyfile` (mirrors the tunnel's path rules)**

```caddyfile
{
	admin off
	auto_https off
}

# Hub and terminals, like trading.tobytran.dev behind the tunnel.
:8080 {
	handle /u/tradingagents* {
		reverse_proxy ta-terminal:7681 {
			header_up Cf-Access-Authenticated-User-Email local-dev@example.test
		}
	}
	handle /u/ai-hedge-fund* {
		reverse_proxy ahf-terminal:7681 {
			header_up Cf-Access-Authenticated-User-Email local-dev@example.test
		}
	}
	handle {
		reverse_proxy web:3000
	}
}

# Vibe-Trading, like vibe-trading.tobytran.dev.
:8899 {
	reverse_proxy vibe-trading:8899
}
```

- [ ] **Step 5: Write `ai-trading/deploy/local/docker-compose.override.yml`**

```yaml
# Local-only overlay for the production compose file. Paths are relative to
# the first compose file (ai-trading/deploy/production/).
services:
  cloudflared:
    profiles: ["production-only"]

  router:
    image: caddy:2-alpine
    volumes:
      - ../local/Caddyfile:/etc/caddy/Caddyfile:ro
    ports:
      - "127.0.0.1:8080:8080"
      - "127.0.0.1:8899:8899"
    networks: [hub, ta, ahf, vibe]
    depends_on: [web, ta-terminal, ahf-terminal, vibe-trading]
```

- [ ] **Step 6: Write `ai-trading/deploy/local/local.env`**

```dotenv
# Compose interpolation for the local stack (pass with --env-file).
AI_TRADING_REGISTRY=ghcr.io/thangtran3112/family-app
AI_TRADING_IMAGE_TAG=local
# Relative to ai-trading/deploy/production/, the first compose file's directory.
AI_TRADING_SECRETS_DIR=../local/secrets
```

- [ ] **Step 7: Write `ai-trading/deploy/local/README.md`**

````markdown
# Local Stack

Runs the release 1 stack on a laptop, with Caddy standing in for the Cloudflare Tunnel. Run every command from the repository root.

1. Create local secrets (gitignored):

   ```bash
   mkdir -p ai-trading/deploy/local/secrets
   for f in ai-trading/deploy/production/env/*.env.example; do
     cp "$f" "ai-trading/deploy/local/secrets/$(basename "$f" .example)"
   done
   ```

   In the copies, delete every line whose value is `replace-me`. Then set `API_AUTH_KEY=local-dev-key` in `vibe-trading.env` and `TUNNEL_TOKEN=unused-locally` in `cloudflared.env`. Add provider keys only if you want real LLM runs.

2. Build the images:

   ```bash
   TAG=local VIBE_TRADING_URL=http://localhost:8899 docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
   ```

3. Start the stack:

   ```bash
   docker compose -p ai-trading-local --env-file ai-trading/deploy/local/local.env \
     -f ai-trading/deploy/production/docker-compose.yml \
     -f ai-trading/deploy/local/docker-compose.override.yml up -d --wait
   ```

4. Open http://localhost:8080 for the hub. Vibe-Trading is at http://localhost:8899; paste `local-dev-key` when it asks.

5. Stop the stack: run the same compose command with `down` instead of `up -d --wait`.
````

- [ ] **Step 8: Static checks**

```bash
docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:stable ai-trading/deploy/ci/smoke-test.sh
docker buildx bake -f ai-trading/deploy/docker-bake.hcl --print >/dev/null && echo "ok bake file parses"
docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl --print >/dev/null && echo "ok bake ci overlay parses"
```

Expected: no shellcheck findings, then both `ok` lines.

- [ ] **Step 9: Build and smoke-test Vibe-Trading (this task owns that verification)**

```bash
TAG=local docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load vibe-trading
TAG=local ai-trading/deploy/ci/smoke-test.sh vibe-trading
```

Expected: four `ok` lines (`/live`, then 200, 403, and 401 for `/auth/sse-ticket`) and `smoke tests passed: vibe-trading`. If the 200 case returns 403, report the response body. It means uvicorn did not trust `X-Forwarded-Proto`, which is the spike's first fallback trigger.

- [ ] **Step 10: Run the full smoke tests once Tasks 1, 2, and 4 have files in place**

If their files already exist when you reach this step:

```bash
TAG=local docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
TAG=local ai-trading/deploy/ci/smoke-test.sh all
```

Otherwise report "pending integration", and Task 7 runs it.
