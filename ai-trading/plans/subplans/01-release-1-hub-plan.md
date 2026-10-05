# Release 1 Trading Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks 1-6 run in parallel, one subagent each; their full steps live in `01-release-1-hub-tasks/`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Trading Hub MVP: a Next.js hub at `trading.tobytran.dev` that runs TradingAgents and ai-hedge-fund as browser terminals and links Vibe-Trading on `vibe-trading.tobytran.dev`, all three unmodified, deployed to the OVH VPS as infrastructure as code.

**Architecture:** One Docker Compose project (`ai-trading`) with five services: `web` (hub), `ta-terminal`, `ahf-terminal`, `vibe-trading`, and `cloudflared`. A dedicated Cloudflare Tunnel routes paths to services, and a Cloudflare Access application gates both hostnames. Images are built with Docker Buildx Bake from git submodules (upstream code) plus our wrapper Dockerfiles, pushed to GHCR, and deployed over SSH by GitHub Actions.

**Tech Stack:** Next.js 16 (App Router, TypeScript, Tailwind CSS 4), pnpm 11.9.0, Node 24; ttyd 1.7.7 and tmux; Docker Compose and Buildx Bake; Cloudflare provider 5.x for Terraform (>= 1.10); GitHub Actions; Dependabot.

**Spec:** [01-release-1-hub-design.md](01-release-1-hub-design.md)

## Global Constraints

- Never edit files under `ai-trading/packages/` (upstream submodules).
- `family-app` is public: no secrets, email addresses, balances, or account numbers in the repository. Real env files live in a secrets bundle outside the repository.
- Git: work in the worktree `/Users/tobytran/personal/family-app/.worktrees/ai-trading-hub` on branch `feature/ai-trading-hub`. Another session resets `feature/toby` in the main checkout. Subagents never run `git add`, `git commit`, or `git push`; the main session commits after review. One pull request to `dev`. Anything targeting `main` needs explicit approval from the user at that moment.
- Hostnames: `trading.tobytran.dev` (hub and terminals), `vibe-trading.tobytran.dev`.
- Ports: `web` 3000, terminals 7681, `vibe-trading` 8899, `cloudflared` metrics 2000.
- Identity header from Cloudflare Access: `Cf-Access-Authenticated-User-Email`.
- Image names: `ghcr.io/thangtran3112/family-app/ai-trading-web`, `ai-trading-ta-terminal`, `ai-trading-ahf-terminal`, `ai-trading-vibe-trading`.
- Memory limits: `web` 256 MB, each terminal 1 GB, `vibe-trading` 2 GB, `cloudflared` 128 MB.
- Pinned versions: Node 24, pnpm 11.9.0, ttyd 1.7.7 (`ttyd.x86_64` sha256 `8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55`, `ttyd.aarch64` sha256 `b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165`), `python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5`, Poetry 1.8.5 (generator of the upstream lock), Cloudflare provider `>= 5.8.2, < 6.0.0`.
- No broker credentials anywhere. No order placement.

## Review Focus

1. Terminal identity: the same user always lands in the same tmux session, two users never share one, and a missing or odd header falls back to `default`. Test: `deploy/upstream/terminal/test-session.sh` (Task 2).
2. Reconnect reattaches to the running app, and the app runs without a shell. Tests: tmux probe in Task 2 and `smoke-test.sh`; browser reconnect check in Task 7.
3. Vibe-Trading behind the TLS tunnel accepts its own UI's POST requests and still rejects cross-site ones. Test: `smoke-test.sh vibe-trading` positive and negative cases (Task 3).
4. Unknown and planned hub routes (`/apps/desk`, `/apps/unknown`) return 404 instead of crashing. Tests: Task 1 checks and `smoke-test.sh web`.
5. Containers start healthy with no LLM or data keys, and ttyd refuses requests without the Access header (407). Test: `smoke-test.sh` (Task 3).

## Execution Map

| Wave | Who | Tasks |
|---|---|---|
| 0 | Main session, sequential | Task 0: branch sync, local tooling, submodules |
| 1 | Six parallel subagents | Tasks 1-6 (disjoint files, table below) |
| 2 | Main session | Task 7: integration, reviews, commits, pull request |
| 3 | Main session with the user | Task 8: accounts, spike, first production deploy |

| Task | Subagent owns (only these paths) | Task file |
|---|---|---|
| 1 Hub web app | `ai-trading/frontend/**` | [task-1-hub-web.md](01-release-1-hub-tasks/task-1-hub-web.md) |
| 2 Terminal images | `ai-trading/deploy/upstream/**` | [task-2-terminal-images.md](01-release-1-hub-tasks/task-2-terminal-images.md) |
| 3 Build, smoke tests, local stack | `ai-trading/deploy/docker-bake.hcl`, `ai-trading/deploy/docker-bake.ci.hcl`, `ai-trading/deploy/ci/**`, `ai-trading/deploy/local/**` | [task-3-build-smoke-local.md](01-release-1-hub-tasks/task-3-build-smoke-local.md) |
| 4 Production deploy | `ai-trading/deploy/production/**` | [task-4-production-deploy.md](01-release-1-hub-tasks/task-4-production-deploy.md) |
| 5 Cloudflare Terraform | `infrastructure/cloudflare/ai-trading/**`, `.github/workflows/ai-trading-cloudflare.yml` | [task-5-cloudflare-terraform.md](01-release-1-hub-tasks/task-5-cloudflare-terraform.md) |
| 6 CI and deploy workflows | `.github/workflows/ai-trading-ci.yml`, `.github/workflows/ai-trading-deploy.yml`, `.github/dependabot.yml`, one rule in `.github/workflows/expense-tax-ci.yml` | [task-6-ci-deploy-workflows.md](01-release-1-hub-tasks/task-6-ci-deploy-workflows.md) |

Subagent rules:

- Edit only the owned paths. Read anything.
- Never run git write commands.
- Docker builds may run concurrently on the Mac; Vibe-Trading's build is the slowest (expect 10-20 minutes).
- Finish with a report: files created or changed, every verification command run with its exact result, and anything that deviated from the task file.

## Shared Interfaces

All tasks use these names exactly.

| Item | Value |
|---|---|
| Compose project and services | project `ai-trading`; services `web`, `ta-terminal`, `ahf-terminal`, `vibe-trading`, `cloudflared` |
| Networks | `hub` (web), `ta` (ta-terminal), `ahf` (ahf-terminal), `vibe` (vibe-trading); `cloudflared` joins all four |
| Bake file | `ai-trading/deploy/docker-bake.hcl`, always run from the repository root; CI cache overlay `ai-trading/deploy/docker-bake.ci.hcl` |
| Bake variables | `REGISTRY` (default `ghcr.io/thangtran3112/family-app`), `TAG` (default `local`), `VIBE_TRADING_URL` (default `https://vibe-trading.tobytran.dev`) |
| Bake targets | `web`, `terminal-tools`, `ta-upstream`, `ta-terminal`, `ahf-terminal`, `vibe-trading`; group `default` = `web`, `ta-terminal`, `ahf-terminal`, `vibe-trading` |
| Terminal image contract | env `APP_COMMAND`, `TTYD_BASE_PATH`, `TTYD_AUTH_HEADER`; files `/usr/local/bin/ttyd`, `/usr/local/bin/terminal-entrypoint.sh`, `/usr/local/bin/session.sh`, `/etc/ai-trading/tmux.conf` |
| Terminal base paths | `/u/tradingagents` (`tradingagents`), `/u/ai-hedge-fund` (`aihf`) |
| Volumes | `ta-data:/home/appuser/.tradingagents`; `ahf-data:/home/app/.hedge-fund`; `vibe-runs:/app/agent/runs`, `vibe-sessions:/app/agent/sessions`, `vibe-uploads:/app/agent/uploads`, `vibe-swarm-runs:/app/agent/.swarm/runs`, `vibe-home:/home/vibe/.vibe-trading` |
| Compose variables | `AI_TRADING_REGISTRY`, `AI_TRADING_IMAGE_TAG`, `AI_TRADING_SECRETS_DIR` (default `/etc/family-app/ai-trading`) |
| Secret files | `tradingagents.env`, `ai-hedge-fund.env`, `vibe-trading.env`, `cloudflared.env` in the secrets directory, root-owned, mode 0600 |
| VPS paths | `/opt/family-app/ai-trading/` holds `docker-compose.yml`, `deploy.sh`, `health-check.sh`, `images.env`, `last-good-tag` |
| Smoke tests | `ai-trading/deploy/ci/smoke-test.sh [web|ta-terminal|ahf-terminal|vibe-trading|all]`, env `REGISTRY`, `TAG` |
| GitHub environment | `ai-trading-production`. Vars: `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `CLOUDFLARE_ACCOUNT_ID`, `TF_STATE_BUCKET`, `GCP_AI_TRADING_CF_WORKLOAD_IDENTITY_PROVIDER`, `GCP_AI_TRADING_CF_SERVICE_ACCOUNT`. Secrets: `VPS_DEPLOY_SSH_KEY`, `VPS_DEPLOY_KNOWN_HOSTS`, `AI_TRADING_CLOUDFLARE_API_TOKEN`, `AI_TRADING_ACCESS_ALLOWED_EMAILS` (JSON list) |

---

## Task 0: Branch, Local Tooling, Submodules (main session)

**Files:**
- Modify: `ai-trading/.gitignore`
- Create: `.gitmodules` (by `git submodule add`)
- Convert: `ai-trading/packages/trading-agents`, `ai-hedge-fund`, `vibe-trading` into submodules

- [ ] **Step 1: Sync the working branch**

```bash
git fetch origin
git merge --ff-only origin/dev
```

Expected: a fast-forward or "Already up to date." The untracked `ai-trading/` directory is unaffected.

- [ ] **Step 2: Install the Buildx plugin (local Docker has none)**

```bash
brew install docker-buildx
mkdir -p ~/.docker/cli-plugins
ln -sfn "$(brew --prefix)/opt/docker-buildx/bin/docker-buildx" ~/.docker/cli-plugins/docker-buildx
docker buildx version
```

Expected: `github.com/docker/buildx v0.x.y ...`.

- [ ] **Step 3: Replace `ai-trading/.gitignore`**

```gitignore
# Agent and experiment scratch space. Never committed.
temp/

# Reference checkouts used for evaluation only; never deployed.
packages/deer-flow/
packages/ag-ui/

# Real env files never live in the repository; only *.env.example templates do.
deploy/production/env/*.env
deploy/local/secrets/
```

- [ ] **Step 4: Turn the three deployed checkouts into submodules (reuses the existing clones)**

```bash
git submodule add https://github.com/TauricResearch/TradingAgents.git ai-trading/packages/trading-agents
git submodule add https://github.com/virattt/ai-hedge-fund.git ai-trading/packages/ai-hedge-fund
git submodule add https://github.com/HKUDS/Vibe-Trading.git ai-trading/packages/vibe-trading
git submodule absorbgitdirs
git submodule status
```

Expected: each `add` prints "Adding existing repo at ...". Status shows `1394a3f72aa4...`, `78b779c1389e...`, and `251b094320c1...`.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules ai-trading/.gitignore ai-trading/packages/trading-agents ai-trading/packages/ai-hedge-fund ai-trading/packages/vibe-trading ai-trading/plans
git commit -m "chore(ai-trading): add upstream apps as submodules and release plans"
```

---

## Tasks 1-6 (parallel)

Dispatch six implementer subagents at once, each with its task file and the Global Constraints, Review Focus, and Shared Interfaces sections above. After each report, run a spec-compliance reviewer and a code-quality reviewer for that task (reviewers for different tasks can run in parallel). Fix findings with the same implementer before integration.

---

## Task 7: Integration, Reviews, Commits, Pull Request (main session)

**Files:** none new; fixes go to the owning task's paths.

- [ ] **Step 1: Build every image locally**

```bash
TAG=local VIBE_TRADING_URL=http://localhost:8899 docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load
```

Expected: four images tagged `ghcr.io/thangtran3112/family-app/ai-trading-*:local`.

- [ ] **Step 2: Run all smoke tests**

```bash
TAG=local ai-trading/deploy/ci/smoke-test.sh all
```

Expected: last line `smoke tests passed: all`.

- [ ] **Step 3: Static checks**

```bash
docker run --rm -v "$PWD":/mnt -w /mnt koalaman/shellcheck:stable \
  ai-trading/deploy/upstream/terminal/*.sh ai-trading/deploy/ci/*.sh \
  ai-trading/deploy/production/*.sh infrastructure/cloudflare/ai-trading/*.sh
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest \
  .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml \
  .github/workflows/ai-trading-cloudflare.yml .github/workflows/expense-tax-ci.yml
docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest init -backend=false
docker run --rm -v "$PWD":/w -w /w/infrastructure/cloudflare/ai-trading hashicorp/terraform:latest validate
```

Expected: no shellcheck or actionlint findings; `Success! The configuration is valid.`

- [ ] **Step 4: Run the local stack**

```bash
mkdir -p ai-trading/deploy/local/secrets
for f in ai-trading/deploy/production/env/*.env.example; do
  cp "$f" "ai-trading/deploy/local/secrets/$(basename "$f" .example)"
done
```

Then edit `ai-trading/deploy/local/secrets/*.env` as follows:

- remove every line whose value is `replace-me`;
- set `API_AUTH_KEY=local-dev-key` in `vibe-trading.env`;
- set `TUNNEL_TOKEN=unused-locally` in `cloudflared.env`.

```bash
docker compose -p ai-trading-local --env-file ai-trading/deploy/local/local.env \
  -f ai-trading/deploy/production/docker-compose.yml \
  -f ai-trading/deploy/local/docker-compose.override.yml up -d --wait
```

Expected: `web`, both terminals, `vibe-trading`, and `router` are healthy or running; `cloudflared` is not started.

- [ ] **Step 5: Browser check with Playwright (save screenshots to `ai-trading/temp/e2e/`)**

1. Open `http://localhost:8080/`: four cards, with Family Desk disabled.
2. Open `/apps/tradingagents`: the iframe shows the TradingAgents prompt. Click "Reconnect": the same screen state returns (tmux reattach).
3. Open `/apps/ai-hedge-fund`: the Textual UI renders.
4. Open `/apps/vibe-trading`, then the "Open Vibe-Trading" button: `http://localhost:8899` loads; paste `local-dev-key` when asked; the UI responds.
5. Open `/apps/desk` and `/apps/unknown`: both show the 404 page.

- [ ] **Step 6: Stop the local stack**

```bash
docker compose -p ai-trading-local --env-file ai-trading/deploy/local/local.env \
  -f ai-trading/deploy/production/docker-compose.yml \
  -f ai-trading/deploy/local/docker-compose.override.yml down
```

- [ ] **Step 7: Commit each task separately (exact paths only)**

```bash
git add ai-trading/frontend && git commit -m "feat(ai-trading): add Trading Hub web app"
git add ai-trading/deploy/upstream && git commit -m "feat(ai-trading): add browser terminal images for TradingAgents and ai-hedge-fund"
git add ai-trading/deploy/docker-bake.hcl ai-trading/deploy/docker-bake.ci.hcl ai-trading/deploy/ci ai-trading/deploy/local && git commit -m "feat(ai-trading): add image build, smoke tests, and local stack"
git add ai-trading/deploy/production && git commit -m "feat(ai-trading): add production compose, deploy scripts, and runbook"
git add infrastructure/cloudflare/ai-trading .github/workflows/ai-trading-cloudflare.yml && git commit -m "feat(infra): add Cloudflare tunnel and Access for ai-trading"
git add .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml .github/dependabot.yml .github/workflows/expense-tax-ci.yml && git commit -m "ci(ai-trading): add CI, deploy, and weekly upstream updates"
```

- [ ] **Step 8: Update STATUS.md and commit**

Mark Phase 2 done and Phase 3 in progress, and record any deviations found during integration.

```bash
git add ai-trading/plans/STATUS.md && git commit -m "docs(ai-trading): record release 1 build progress"
```

- [ ] **Step 9: Push and open one pull request to `dev`**

```bash
git push -u origin feature/ai-trading-hub
gh pr create --base dev --head feature/ai-trading-hub --title "feat(ai-trading): Trading Hub MVP (release 1)" --body-file ai-trading/temp/pr-body.md
```

Write `ai-trading/temp/pr-body.md` first: a summary, test evidence from Steps 2-5, and the operator steps that remain (Task 8). Merge with squash once the required check and `ai-trading-ci` are green (standing approval for `dev`).

---

## Task 8: Accounts, Spike, First Production Deploy (main session with the user)

Every step marked **(user)** needs the user at a console or device. Record each outcome in `STATUS.md`.

- [ ] **Step 1 (user): OVH headroom.** Run the following and compare with the roughly 4.5 GB memory and 15 GB disk the stack needs. If it does not fit, use the home Ubuntu server with the same runbook.

  ```bash
  ssh -p <port> <user>@<host> 'free -m; nproc; df -h /; docker stats --no-stream --format "{{.Name}} {{.MemUsage}}"'
  ```
- [ ] **Step 2 (user): Cloudflare Zero Trust.**
  - Create the organization (free plan; Cloudflare may ask for a payment method) and note the team domain.
  - Do not create an identity provider by hand. Terraform creates the one-time PIN provider. If one already exists, import it as `infrastructure/cloudflare/ai-trading/README.md` describes.
- [ ] **Step 3 (user): Cloudflare API token** `ai-trading-terraform`, with permissions `Access: Apps and Policies Write`, `Access: Organizations, Identity Providers, and Groups Write`, `Cloudflare Tunnel Write`, and `DNS Write` on `tobytran.dev`.
- [ ] **Step 4 (user): GCP identity for the Terraform workflow.** Run `infrastructure/cloudflare/ai-trading/bootstrap-wif.sh` with the user's `gcloud` login.
- [ ] **Step 5 (user): GitHub environment.**
  - Create `ai-trading-production` with the vars and secrets listed in Shared Interfaces.
  - `VPS_*` and the deploy SSH key can reuse the expense `production` environment's values for the same VPS.
- [ ] **Step 6 (user): LLM keys and spend limits.**
  - One Anthropic workspace and one OpenAI project per app (`ai-trading-tradingagents`, `ai-trading-ai-hedge-fund`, `ai-trading-vibe-trading`), each with a $10 monthly limit.
  - If OpenAI project budgets only alert, fund those projects with prepaid credit and keep auto-recharge off.
- [ ] **Step 7 (user): Secrets bundle.** Create `~/secure/ai-trading/` (mode 700) from the `env/*.env.example` templates.
  - Choose model IDs for `TRADINGAGENTS_*_LLM`, `HEDGE_FUND_LLM_MODEL`, and `LANGCHAIN_*`.
  - Generate `API_AUTH_KEY` with `openssl rand -hex 32`.
- [ ] **Step 8: First Terraform apply from the operator machine.** The CI apply job only runs from `main`, and the stack needs a tunnel token before its first deploy. Follow the README's "First apply" section:
  - run `terraform apply` locally;
  - write `TUNNEL_TOKEN=$(terraform output -raw tunnel_token)` into `cloudflared.env`.
- [ ] **Step 9: Install secrets on the VPS.** `ai-trading/deploy/production/write-secrets.sh --host ... --port ... --user ... --key ... --bundle-dir ~/secure/ai-trading`.
- [ ] **Step 10 (user approval required): Release to `main` with ai-trading paths only.** Merging `dev` into `main` would also release undeployed expense phases.
  - Create `feature/ai-trading-release-1` from `origin/main`.
  - Run `git checkout origin/dev -- ai-trading .gitmodules infrastructure/cloudflare/ai-trading .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml .github/workflows/ai-trading-cloudflare.yml`, commit, open a pull request to `main`, and merge after approval.
  - The push to `main` runs `ai-trading-ci`, then `ai-trading-deploy`.
- [ ] **Step 11 (user): Acceptance checklist** (spec section 12) on a Mac and an iPad, plus the remaining spike checks:
  - Access session behavior;
  - tunnel headers and websockets;
  - terminal reattach after the iPad sleeps;
  - per-user sessions;
  - spend-limit behavior;
  - the first grouped Dependabot pull request passing the required check;
  - Financial Datasets pricing.
- [ ] **Step 12:** Update `STATUS.md`: Phase 3 done, spike outcomes, and any fallbacks taken.
