# Task 4: Production Compose, Deploy Scripts, Secrets, Runbook

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `ai-trading/deploy/production/**` only. Do not run `git add`, `git commit`, or `git push`.

**Files:**
- Create: `docker-compose.yml`, `deploy.sh`, `health-check.sh`, `write-secrets.sh`, `README.md`
- Create: `env/tradingagents.env.example`, `env/ai-hedge-fund.env.example`, `env/vibe-trading.env.example`, `env/cloudflared.env.example`

All paths are under `ai-trading/deploy/production/`.

**Interfaces:**
- Consumes: the image names, ports, volumes, and terminal health URLs from Shared Interfaces.
  - The cloudflared image entrypoint is `cloudflared --no-autoupdate`. It reads `TUNNEL_TOKEN` and serves `/ready` on `--metrics`.
  - Vibe-Trading saves settings-page edits to `~/.vibe-trading/.env`, which lives in the `vibe-home` volume. Its env file is therefore input only and is not mounted.
- Produces:
  - The compose file. Task 3's local overlay and Task 6's CI use it, as does the deploy workflow.
  - `deploy.sh`, run on the VPS as `sudo env DOCKER_CONFIG=... IMAGE_TAG=<sha> /opt/family-app/ai-trading/deploy.sh`.
  - `health-check.sh`.
  - `write-secrets.sh`, run by the operator.

- [ ] **Step 1: Write `docker-compose.yml`**

```yaml
# ai-trading production stack (release 1: Trading Hub MVP).
# Deployed by .github/workflows/ai-trading-deploy.yml through deploy.sh.
name: ai-trading

services:
  web:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-web:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    networks: [hub]
    mem_limit: 256m
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3

  ta-terminal:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-ta-terminal:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/tradingagents.env
    volumes:
      - ta-data:/home/appuser/.tradingagents
    networks: [ta]
    mem_limit: 1g
    pids_limit: 512
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:7681/u/tradingagents/', headers={'Cf-Access-Authenticated-User-Email': 'healthcheck'}), timeout=4)"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

  ahf-terminal:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-ahf-terminal:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/ai-hedge-fund.env
    volumes:
      - ahf-data:/home/app/.hedge-fund
    networks: [ahf]
    mem_limit: 1g
    pids_limit: 512
    security_opt: ["no-new-privileges:true"]
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request as u; u.urlopen(u.Request('http://127.0.0.1:7681/u/ai-hedge-fund/', headers={'Cf-Access-Authenticated-User-Email': 'healthcheck'}), timeout=4)"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

  vibe-trading:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-vibe-trading:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/vibe-trading.env
    environment:
      # Trust X-Forwarded-Proto from the tunnel so the same-site check sees https.
      FORWARDED_ALLOW_IPS: "*"
    volumes:
      - vibe-runs:/app/agent/runs
      - vibe-sessions:/app/agent/sessions
      - vibe-uploads:/app/agent/uploads
      - vibe-swarm-runs:/app/agent/.swarm/runs
      - vibe-home:/home/vibe/.vibe-trading
    networks: [vibe]
    # Upstream hardening (Vibe-Trading docker-compose.yml, VT-007), memory lowered for the shared VPS.
    cap_drop: [ALL]
    cap_add: [SETUID, SETGID]
    security_opt: ["no-new-privileges:true"]
    read_only: true
    tmpfs:
      - /tmp
      - /home/vibe/.cache
      - /home/vibe/.config
    pids_limit: 512
    mem_limit: 2g
    cpus: 2
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8899/live', timeout=4)"]
      interval: 30s
      timeout: 5s
      start_period: 120s
      retries: 3

  cloudflared:
    image: cloudflare/cloudflared:2026.9.3
    restart: unless-stopped
    command: ["tunnel", "--metrics", "0.0.0.0:2000", "run"]
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/cloudflared.env
    networks: [hub, ta, ahf, vibe]
    mem_limit: 128m
    security_opt: ["no-new-privileges:true"]

networks:
  hub: {}
  ta: {}
  ahf: {}
  vibe: {}

volumes:
  ta-data: {}
  ahf-data: {}
  vibe-runs: {}
  vibe-sessions: {}
  vibe-uploads: {}
  vibe-swarm-runs: {}
  vibe-home: {}
```

Then pin cloudflared by digest:

```bash
docker buildx imagetools inspect cloudflare/cloudflared:2026.9.3 --format '{{json .Manifest.Digest}}'
```

Replace the image line with `cloudflare/cloudflared:2026.9.3@sha256:<digest>`.

- [ ] **Step 2: Write the env templates (names only; real files live in the secrets bundle)**

`env/tradingagents.env.example`:

```dotenv
# TradingAgents (browser terminal). Copy to tradingagents.env in the secrets bundle.
# Keys come from the dedicated "ai-trading-tradingagents" Anthropic workspace / OpenAI project.
# Delete lines you do not use: exported empty values override app defaults.
ANTHROPIC_API_KEY=replace-me
OPENAI_API_KEY=replace-me
TRADINGAGENTS_LLM_PROVIDER=anthropic
TRADINGAGENTS_DEEP_THINK_LLM=replace-me
TRADINGAGENTS_QUICK_THINK_LLM=replace-me
# Optional, free key for macro data: https://fred.stlouisfed.org/docs/api/api_key.html
FRED_API_KEY=replace-me
```

`env/ai-hedge-fund.env.example`:

```dotenv
# ai-hedge-fund (browser terminal). Copy to ai-hedge-fund.env in the secrets bundle.
# Keys come from the dedicated "ai-trading-ai-hedge-fund" Anthropic workspace.
ANTHROPIC_API_KEY=replace-me
HEDGE_FUND_LLM_MODEL=replace-me
# Leave FINANCIAL_DATASETS_API_KEY out until it is purchased: an exported variable,
# even an empty one, overrides the key saved in the app's own key screen.
# FINANCIAL_DATASETS_API_KEY=replace-me
```

`env/vibe-trading.env.example`:

```dotenv
# Vibe-Trading (vibe-trading.tobytran.dev). Copy to vibe-trading.env in the secrets bundle.
# Shared access key each user pastes once per browser. Generate: openssl rand -hex 32
API_AUTH_KEY=replace-me
# LLM settings; names from ai-trading/packages/vibe-trading/agent/.env.example.
# Keys come from the dedicated "ai-trading-vibe-trading" Anthropic workspace.
LANGCHAIN_PROVIDER=anthropic
LANGCHAIN_MODEL_NAME=replace-me
ANTHROPIC_API_KEY=replace-me
```

`env/cloudflared.env.example`:

```dotenv
# Cloudflare Tunnel connector token. From infrastructure/cloudflare/ai-trading:
#   terraform output -raw tunnel_token
TUNNEL_TOKEN=replace-me
```

- [ ] **Step 3: Write `deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploys one image tag of the ai-trading stack. Runs on the VPS as root.
#   IMAGE_TAG      commit SHA built by .github/workflows/ai-trading-deploy.yml (required)
#   DOCKER_CONFIG  registry credentials prepared by the workflow (optional)
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
SECRETS_DIR="${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}"
REGISTRY="${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}"
STATE_FILE="$APP_DIR/last-good-tag"
IMAGES_ENV="$APP_DIR/images.env"
SECRET_FILES=(tradingagents.env ai-hedge-fund.env vibe-trading.env cloudflared.env)

die() {
  echo "deploy: $*" >&2
  exit 1
}

[[ "${IMAGE_TAG:-}" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]] || die "IMAGE_TAG must be a full commit SHA"
for name in "${SECRET_FILES[@]}"; do
  file="$SECRETS_DIR/$name"
  [[ -f "$file" ]] || die "missing $file; run write-secrets.sh first"
  [[ "$(stat -c '%u:%a' "$file")" == "0:600" ]] || die "$file must be owned by root with mode 600"
done

compose() {
  docker compose --project-name ai-trading --env-file "$IMAGES_ENV" -f "$APP_DIR/docker-compose.yml" "$@"
}

deploy_tag() {
  local tag="$1" tmp
  tmp="$(mktemp "$APP_DIR/images.env.XXXXXX")"
  printf 'AI_TRADING_REGISTRY=%s\nAI_TRADING_IMAGE_TAG=%s\nAI_TRADING_SECRETS_DIR=%s\n' "$REGISTRY" "$tag" "$SECRETS_DIR" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$IMAGES_ENV"
  compose pull
  compose up -d --remove-orphans --wait --wait-timeout 300
  "$APP_DIR/health-check.sh"
}

rollback() {
  local status="$1" previous=""
  trap - ERR
  if [[ -f "$STATE_FILE" ]]; then
    previous="$(cat "$STATE_FILE")"
  fi
  if [[ -n "$previous" && "$previous" != "$IMAGE_TAG" ]]; then
    echo "deploy: failed with status $status; rolling back to $previous" >&2
    deploy_tag "$previous" || echo "deploy: rollback to $previous failed too" >&2
  else
    echo "deploy: failed with status $status; no earlier tag to roll back to" >&2
  fi
  exit "$status"
}
trap 'rollback "$?"' ERR

install -d -m 0755 "$APP_DIR"
deploy_tag "$IMAGE_TAG"
printf '%s\n' "$IMAGE_TAG" >"$STATE_FILE.tmp"
mv -f "$STATE_FILE.tmp" "$STATE_FILE"
echo "deploy: ai-trading is running $IMAGE_TAG"
```

- [ ] **Step 4: Write `health-check.sh`**

```bash
#!/usr/bin/env bash
# Verifies the running ai-trading stack: every service running, health checks
# passing, and the Cloudflare Tunnel connected. Runs on the VPS as root.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/family-app/ai-trading}"
ATTEMPTS="${HEALTH_CHECK_ATTEMPTS:-30}"
DELAY="${HEALTH_CHECK_DELAY_SECONDS:-2}"
SERVICES=(web ta-terminal ahf-terminal vibe-trading cloudflared)

compose() {
  docker compose --project-name ai-trading --env-file "$APP_DIR/images.env" -f "$APP_DIR/docker-compose.yml" "$@"
}

service_ok() {
  local id state health
  id="$(compose ps -q "$1")"
  [[ -n "$id" ]] || return 1
  state="$(docker inspect -f '{{.State.Status}}' "$id")"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id")"
  [[ "$state" == running && ("$health" == healthy || "$health" == none) ]]
}

# cloudflared is distroless, so ask from the web container on the shared network.
tunnel_ready() {
  compose exec -T web node -e "fetch('http://cloudflared:2000/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
}

failing=()
for ((attempt = 1; attempt <= ATTEMPTS; attempt++)); do
  failing=()
  for service in "${SERVICES[@]}"; do
    service_ok "$service" || failing+=("$service")
  done
  if ((${#failing[@]} == 0)) && tunnel_ready; then
    echo "health-check: all services healthy; tunnel connected"
    exit 0
  fi
  sleep "$DELAY"
done
echo "health-check: failing services: ${failing[*]:-none}; tunnel connected: $(tunnel_ready && echo yes || echo no)" >&2
exit 1
```

- [ ] **Step 5: Write `write-secrets.sh`**

```bash
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
```

Then run `chmod +x ai-trading/deploy/production/*.sh`.

- [ ] **Step 6: Write `README.md` (runbook)**

````markdown
# ai-trading Production Runbook

Release 1 runs the Trading Hub and three unmodified upstream apps on one host behind a dedicated Cloudflare Tunnel and Cloudflare Access application. Design: `ai-trading/plans/subplans/01-release-1-hub-design.md`.

| Service | Reached at | Notes |
|---|---|---|
| `web` | `https://trading.tobytran.dev/` | Hub |
| `ta-terminal` | `https://trading.tobytran.dev/u/tradingagents/` | TradingAgents in ttyd + tmux |
| `ahf-terminal` | `https://trading.tobytran.dev/u/ai-hedge-fund/` | ai-hedge-fund in ttyd + tmux |
| `vibe-trading` | `https://vibe-trading.tobytran.dev/` | Upstream image with upstream hardening |
| `cloudflared` | outbound only | Tunnel connector |

On the host:

- `/opt/family-app/ai-trading/` holds the compose file, the scripts, `images.env`, and `last-good-tag`.
- `/etc/family-app/ai-trading/` holds one root-only env file per service.

## One-time setup

1. Cloudflare Zero Trust: create the organization (free plan; Cloudflare may ask for a payment method). Terraform creates the one-time PIN login method.
2. Cloudflare API token `ai-trading-terraform` with these permissions:
   - `Access: Apps and Policies Write`
   - `Access: Organizations, Identity Providers, and Groups Write`
   - `Cloudflare Tunnel Write`
   - `DNS Write` on `tobytran.dev`
3. GCP identity for the Terraform workflow: run `infrastructure/cloudflare/ai-trading/bootstrap-wif.sh`.
4. GitHub environment `ai-trading-production`:
   - vars `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `CLOUDFLARE_ACCOUNT_ID`, `TF_STATE_BUCKET`, `GCP_AI_TRADING_CF_WORKLOAD_IDENTITY_PROVIDER`, `GCP_AI_TRADING_CF_SERVICE_ACCOUNT`;
   - secrets `VPS_DEPLOY_SSH_KEY`, `VPS_DEPLOY_KNOWN_HOSTS`, `AI_TRADING_CLOUDFLARE_API_TOKEN`, and `AI_TRADING_ACCESS_ALLOWED_EMAILS` (a JSON list such as `["a@example.com","b@example.com"]`).
5. LLM keys:
   - Create one Anthropic workspace and one OpenAI project per app (`ai-trading-tradingagents`, `ai-trading-ai-hedge-fund`, `ai-trading-vibe-trading`), each with a monthly spend limit (start at $10).
   - If an OpenAI project budget only alerts, fund that project with prepaid credit and turn auto-recharge off.
6. Secrets bundle:
   - Create `~/secure/ai-trading/` (mode 700) and copy `env/*.env.example` into it without the `.example` suffix.
   - Fill in the real values and delete unused lines. `write-secrets.sh` rejects empty or `replace-me` values.

## First deploy

1. Apply Terraform once from the operator machine (see `infrastructure/cloudflare/ai-trading/README.md`, "First apply").
2. Put `TUNNEL_TOKEN=<terraform output -raw tunnel_token>` into `~/secure/ai-trading/cloudflared.env`.
3. Install the secrets:

   ```bash
   ai-trading/deploy/production/write-secrets.sh --host <host> --port <port> --user <user> \
     --key ~/.ssh/<deploy-key> --bundle-dir ~/secure/ai-trading
   ```

4. Release to `main` with ai-trading paths only (never merge all of `dev` into `main`). The push runs `ai-trading-ci`, then `ai-trading-deploy`, which builds images, pushes them to GHCR, and runs `deploy.sh` and `health-check.sh` on the host.

## Acceptance checklist (Mac and iPad)

1. Access login works on both hostnames.
2. The hub home page and navigation work.
3. One TradingAgents analysis completes.
4. After closing the tab mid-run, reopening the route reattaches to the running session.
5. ai-hedge-fund opens its terminal UI and reaches a backtest screen (with a data key) or its missing-key prompt.
6. Vibe-Trading opens, accepts the access key, and answers one chat request.

## Operations

- Logs: `sudo docker compose -p ai-trading --env-file /opt/family-app/ai-trading/images.env -f /opt/family-app/ai-trading/docker-compose.yml logs -f <service>`
- Redeploy the current tag: `sudo env IMAGE_TAG=$(cat /opt/family-app/ai-trading/last-good-tag) /opt/family-app/ai-trading/deploy.sh`. The GHCR login is needed only if the images are no longer cached on the host.
- Rotate the Vibe-Trading access key: change `API_AUTH_KEY` in the bundle, rerun `write-secrets.sh`, redeploy, and paste the new key in each browser.
- Upstream updates arrive as one grouped Dependabot pull request per week. Merge it to `dev` when CI is green, then release to `main`.

## Moving to a new host

1. Run `infrastructure/vps/bootstrap.sh --only firewall,ssh,docker` against the new host.
2. Run `write-secrets.sh` against it.
3. Point the `ai-trading-production` environment vars and SSH secrets at it.
4. Rerun the deploy workflow.
5. Stop the stack on the old host: `sudo docker compose -p ai-trading ... down`.

App data in the Docker volumes is trial data and is not copied. Release 2 adds backups.

## Local development

See `ai-trading/deploy/local/README.md`.
````

- [ ] **Step 7: Verify**

```bash
docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:stable ai-trading/deploy/production/*.sh
tmp="$(mktemp -d)"
for name in tradingagents ai-hedge-fund vibe-trading cloudflared; do : >"$tmp/$name.env"; done
AI_TRADING_SECRETS_DIR="$tmp" AI_TRADING_IMAGE_TAG=0123456789abcdef0123456789abcdef01234567 \
  docker compose -f ai-trading/deploy/production/docker-compose.yml config --quiet && echo "ok compose config"
mkdir -p "$tmp/bundle"
printf 'API_AUTH_KEY=\n' >"$tmp/bundle/vibe-trading.env"
for name in tradingagents ai-hedge-fund cloudflared; do printf 'X=1\n' >"$tmp/bundle/$name.env"; done
ai-trading/deploy/production/write-secrets.sh --host h --port 1 --user u --key k --bundle-dir "$tmp/bundle"; echo "exit=$?"
rm -rf "$tmp"
```

Expected:

- no shellcheck findings;
- `ok compose config`;
- `write-secrets.sh` prints `... has empty or replace-me values ...` and `exit=1`, before any SSH connection.
