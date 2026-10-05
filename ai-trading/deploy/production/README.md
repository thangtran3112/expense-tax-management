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
