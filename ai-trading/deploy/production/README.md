# ai-trading Production Runbook

Release 1 runs the Trading Hub and three unmodified upstream apps on one host behind a dedicated Cloudflare Tunnel and Cloudflare Access application. Design: `ai-trading/plans/subplans/01-release-1-hub-design.md`. Infrastructure as code: `ai-trading/plans/subplans/01c-release-1-infra-plan.md`.

| Service | Reached at | Notes |
|---|---|---|
| `web` | `https://trading.tobytran.dev/` | Hub |
| `ta-terminal` | `https://trading.tobytran.dev/u/tradingagents/` | TradingAgents in ttyd + tmux |
| `ahf-terminal` | `https://trading.tobytran.dev/u/ai-hedge-fund/` | ai-hedge-fund in ttyd + tmux |
| `vibe-trading` | `https://vibe-trading.tobytran.dev/` | Upstream image with upstream hardening |
| `cloudflared` | outbound only | Tunnel connector |

On the host:

- `/opt/family-app/ai-trading/` holds the compose file, the scripts, `images.env`, and `last-good-tag`.
- `/etc/family-app/ai-trading/` holds one root-only env file per service, plus `.previous/` (the files from the deploy before last, restored automatically if a deploy fails).

Every secret and environment value lives in one GCP Secret Manager bundle (`ai-trading-env-bundle`, project `tobytran-portfolio`), never in a file inside this repository. See `ai-trading/AGENTS.md` for the secrets rules and the Cloudflare token policy, and `infrastructure/secrets/README.md` for the bundle grammar and the `env-bundle.py` commands used below.

## Bootstrap (once, in order)

1. State bucket: `CLOUDSDK_ACTIVE_CONFIG_NAME=personal infrastructure/gcp/bootstrap-state.sh --project tobytran-portfolio --bucket tobytran-portfolio-tfstate`.
2. Apply `infrastructure/gcp/ai-trading` (creates the Secret Manager bundle, the `ai-trading-deploy` and `ai-trading-terraform` workload identity pools, and their service accounts). See that root's README for the access-token apply steps.
3. Compose the first bundle locally and push it (see "Editing secrets" below); it must exist before any Terraform apply that reads Cloudflare values out of it, and before the first deploy.
4. Apply `infrastructure/cloudflare/zero-trust`, then `infrastructure/cloudflare/ai-trading`, through `env-bundle.py exec ai-trading cloudflare -- terraform ...` (see those roots' READMEs).
5. Release to `main` with ai-trading paths only (never merge all of `dev` into `main`). The push runs `ai-trading-deploy`, which builds images, pushes them to GHCR, renders env files from the bundle, and deploys to the VPS.

## Editing secrets

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 infrastructure/secrets/env-bundle.py pull ai-trading /tmp/ai-trading-env-bundle.ini
# edit /tmp/ai-trading-env-bundle.ini
CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 infrastructure/secrets/env-bundle.py check /tmp/ai-trading-env-bundle.ini
CLOUDSDK_ACTIVE_CONFIG_NAME=personal python3 infrastructure/secrets/env-bundle.py push ai-trading /tmp/ai-trading-env-bundle.ini
rm -f /tmp/ai-trading-env-bundle.ini
```

Delete the local copy as soon as the push succeeds; never let it linger on disk or enter `ai-trading/`. LLM keys come from one Anthropic workspace and one OpenAI project per app (`ai-trading-tradingagents`, `ai-trading-ai-hedge-fund`, `ai-trading-vibe-trading`), each with a monthly spend limit (start at $10). If an OpenAI project budget only alerts, fund that project with prepaid credit and turn auto-recharge off.

## Deploy

Every push to `main` touching `ai-trading/**` (or a manual `workflow_dispatch`) runs `.github/workflows/ai-trading-deploy.yml`:

1. `build`: builds and smoke-tests the images, then pushes them to GHCR tagged with the commit SHA.
2. `deploy` (environment `ai-trading-production`): authenticates to GCP over Workload Identity Federation (no stored key), renders `tradingagents.env`, `ai-hedge-fund.env`, `vibe-trading.env`, and `cloudflared.env` from the bundle (`ai-trading/deploy/ci/render-env.sh`), fetches the OVH deploy SSH key from `expense-tax-env-files`, then copies the compose file, `deploy.sh`, `health-check.sh`, and the rendered env files to the host and runs `deploy.sh`.

`deploy.sh` validates every staged env file (well-formed `KEY=value` lines, no empty value, no NUL or CR byte), backs up the current files to `.previous/`, installs the staged files as `root:root 0600`, then pulls and restarts the stack. If the new tag fails to come up healthy, it restores `.previous/` and rolls back to `last-good-tag`.

## Acceptance checklist (Mac and iPad)

1. Access login works on both hostnames.
2. The hub home page and navigation work.
3. One TradingAgents analysis completes.
4. After closing the tab mid-run, reopening the route reattaches to the running session.
5. ai-hedge-fund opens its terminal UI and reaches a backtest screen (with a data key) or its missing-key prompt.
6. Vibe-Trading opens, the access key is saved in Settings > Local API access > Server API key, and it answers one chat request.

## Operations

- Logs: `sudo docker compose -p ai-trading --env-file /opt/family-app/ai-trading/images.env -f /opt/family-app/ai-trading/docker-compose.yml logs -f <service>`
- Redeploy the current tag: rerun the `ai-trading-deploy` GitHub Actions workflow (`workflow_dispatch`); it re-renders the bundle and redeploys `${{ github.sha }}` of the `main` branch tip. For a manual run on the host instead: `docker login ghcr.io` with a read-only token, then `sudo env IMAGE_TAG=$(cat /opt/family-app/ai-trading/last-good-tag) /opt/family-app/ai-trading/deploy.sh` (no `ENV_STAGING_DIR`, so it reuses the files already in `/etc/family-app/ai-trading/`), then `docker logout ghcr.io` (`deploy.sh` always runs `docker compose pull`, so every redeploy needs registry access while the GHCR packages are private).
- Rotate the Vibe-Trading access key: change `API_AUTH_KEY` in the bundle (see "Editing secrets"), rerun the deploy workflow, and paste the new key in each browser.
- Upstream updates arrive as one grouped Dependabot pull request per week. Merge it to `dev` when CI is green, then release to `main`.

## Moving to a new host

1. Run `infrastructure/vps/bootstrap.sh --only firewall,ssh,docker` against the new host.
2. Update `VPS_HOST`, `VPS_PORT`, `VPS_USER`, and `VPS_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <new-host>`) in the `[deploy]` section of the bundle (see "Editing secrets").
3. Rerun the deploy workflow.
4. Stop the stack on the old host: `sudo docker compose -p ai-trading ... down`.

App data in the Docker volumes is trial data and is not copied. Release 2 adds backups.

## Local development

See `ai-trading/deploy/local/README.md`.
