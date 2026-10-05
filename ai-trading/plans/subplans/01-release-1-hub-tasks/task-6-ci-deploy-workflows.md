# Task 6: CI, Deploy Workflow, Weekly Upstream Updates

Part of [01-release-1-hub-plan.md](../01-release-1-hub-plan.md). Read its Global Constraints and Shared Interfaces first.

**Owned paths:** `.github/workflows/ai-trading-ci.yml`, `.github/workflows/ai-trading-deploy.yml`, `.github/dependabot.yml`, and one `case` rule in `.github/workflows/expense-tax-ci.yml`. Do not run `git add`, `git commit`, or `git push`.

**Files:**
- Create: `.github/workflows/ai-trading-ci.yml`, `.github/workflows/ai-trading-deploy.yml`, `.github/dependabot.yml`
- Modify: `.github/workflows/expense-tax-ci.yml` (step "Enforce feature source branch")

**Interfaces:**
- Consumes:
  - From Task 3: `ai-trading/deploy/docker-bake.hcl` and `docker-bake.ci.hcl`, plus `ai-trading/deploy/ci/smoke-test.sh` (env `TAG`).
  - From Task 2: `ai-trading/deploy/upstream/terminal/test-session.sh`.
  - From Task 4: `ai-trading/deploy/production/docker-compose.yml`, `deploy.sh`, and `health-check.sh`.
  - From Task 3: `ai-trading/deploy/local/docker-compose.override.yml`.
  - The GitHub environment `ai-trading-production` from Shared Interfaces.
- Produces:
  - Workflow name `ai-trading-ci`; the deploy workflow listens for it.
  - On `main`, images tagged with the full commit SHA are deployed to `/opt/family-app/ai-trading`.

Repository facts:

- The `dev` ruleset requires the status check `Contracts, services, workers, frontends`. Expense CI produces that check on every pull request to `dev`.
- In expense CI, the step "Enforce feature source branch" fails any head branch outside `feature/*`. That would block Dependabot pull requests, so it gains `dependabot/*`.
- Expense workflows pin actions by tag: `actions/checkout@v7`, `pnpm/action-setup@v4`, `actions/setup-node@v4`, `docker/setup-buildx-action@v3`, `docker/login-action@v3`. The deploy pattern logs in to GHCR on the VPS per deploy with an ephemeral `DOCKER_CONFIG` in `/dev/shm`.

- [ ] **Step 1: Write `.github/workflows/ai-trading-ci.yml`**

```yaml
name: ai-trading-ci

on:
  push:
    branches: [main]
    paths:
      - "ai-trading/**"
      - "!ai-trading/plans/**"
      - "!ai-trading/**/*.md"
      - ".gitmodules"
      - ".github/workflows/ai-trading-ci.yml"
  pull_request:
    branches: [dev]
    paths:
      - "ai-trading/**"
      - "!ai-trading/plans/**"
      - "!ai-trading/**/*.md"
      - ".gitmodules"
      - ".github/workflows/ai-trading-ci.yml"
  workflow_dispatch:

concurrency:
  group: ai-trading-ci-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

defaults:
  run:
    shell: bash

jobs:
  hub:
    name: Hub web app
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ai-trading/frontend
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v4
        with:
          version: 11.9.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: ai-trading/frontend/pnpm-lock.yaml
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build

  scripts:
    name: Scripts and compose
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Terminal session names
        run: sh ai-trading/deploy/upstream/terminal/test-session.sh
      - name: Shellcheck
        run: |
          shellcheck ai-trading/deploy/upstream/terminal/*.sh ai-trading/deploy/ci/*.sh \
            ai-trading/deploy/production/*.sh infrastructure/cloudflare/ai-trading/*.sh
      - name: Validate compose files
        run: |
          set -euo pipefail
          secrets="$RUNNER_TEMP/ai-trading-secrets"
          mkdir -p "$secrets"
          for name in tradingagents ai-hedge-fund vibe-trading cloudflared; do : >"$secrets/$name.env"; done
          export AI_TRADING_SECRETS_DIR="$secrets"
          export AI_TRADING_IMAGE_TAG=0123456789abcdef0123456789abcdef01234567
          docker compose -f ai-trading/deploy/production/docker-compose.yml config --quiet
          docker compose -f ai-trading/deploy/production/docker-compose.yml \
            -f ai-trading/deploy/local/docker-compose.override.yml config --quiet

  images:
    name: Images and smoke tests
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v7
        with:
          submodules: true
      - uses: docker/setup-buildx-action@v3
      - name: Build images
        uses: docker/bake-action@v7
        env:
          TAG: ci
        with:
          files: |
            ai-trading/deploy/docker-bake.hcl
            ai-trading/deploy/docker-bake.ci.hcl
          load: true
      - name: Smoke tests
        env:
          TAG: ci
        run: ai-trading/deploy/ci/smoke-test.sh all
```

- [ ] **Step 2: Write `.github/workflows/ai-trading-deploy.yml`**

```yaml
name: ai-trading-deploy

on:
  workflow_run:
    workflows: [ai-trading-ci]
    types: [completed]
    branches: [main]

concurrency:
  group: ai-trading-production-deploy
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  build:
    name: Build and push images
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'push' &&
      github.event.workflow_run.head_repository.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          submodules: true
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ github.token }}
      - name: Build and push
        uses: docker/bake-action@v7
        env:
          TAG: ${{ github.event.workflow_run.head_sha }}
        with:
          files: |
            ai-trading/deploy/docker-bake.hcl
            ai-trading/deploy/docker-bake.ci.hcl
          push: true

  deploy:
    name: Deploy to the VPS
    needs: build
    runs-on: ubuntu-latest
    environment: ai-trading-production
    permissions:
      contents: read
      packages: read
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
          sparse-checkout: ai-trading/deploy/production
      - name: Install pinned SSH identity
        env:
          VPS_DEPLOY_SSH_KEY: ${{ secrets.VPS_DEPLOY_SSH_KEY }}
          VPS_DEPLOY_KNOWN_HOSTS: ${{ secrets.VPS_DEPLOY_KNOWN_HOSTS }}
        run: |
          set -euo pipefail
          umask 077
          printf '%s\n' "$VPS_DEPLOY_SSH_KEY" >"$RUNNER_TEMP/ai-trading-deploy-key"
          printf '%s\n' "$VPS_DEPLOY_KNOWN_HOSTS" >"$RUNNER_TEMP/ai-trading-known-hosts"
      - name: Deploy over SSH
        env:
          VPS_HOST: ${{ vars.VPS_HOST }}
          VPS_PORT: ${{ vars.VPS_PORT }}
          VPS_USER: ${{ vars.VPS_USER }}
          GHCR_USER: ${{ github.actor }}
          GITHUB_TOKEN: ${{ github.token }}
          IMAGE_TAG: ${{ github.event.workflow_run.head_sha }}
        run: |
          set -euo pipefail
          echo "::add-mask::$GITHUB_TOKEN"
          key="$RUNNER_TEMP/ai-trading-deploy-key"
          known="$RUNNER_TEMP/ai-trading-known-hosts"
          ssh_opts=(-i "$key" -o UserKnownHostsFile="$known" -o StrictHostKeyChecking=yes -p "$VPS_PORT")
          scp_opts=(-i "$key" -o UserKnownHostsFile="$known" -o StrictHostKeyChecking=yes -P "$VPS_PORT")
          ssh "${ssh_opts[@]}" "$VPS_USER@$VPS_HOST" "install -d -m 0700 /tmp/ai-trading-deploy"
          scp "${scp_opts[@]}" \
            ai-trading/deploy/production/docker-compose.yml \
            ai-trading/deploy/production/deploy.sh \
            ai-trading/deploy/production/health-check.sh \
            "$VPS_USER@$VPS_HOST:/tmp/ai-trading-deploy/"
          printf '%s\n' "$GITHUB_TOKEN" | ssh "${ssh_opts[@]}" "$VPS_USER@$VPS_HOST" \
            "read -r GH_TOKEN; set -Eeuo pipefail; DOCKER_CONFIG=/dev/shm/ai-trading-docker-config-\$\$; cleanup() { sudo env DOCKER_CONFIG=\"\$DOCKER_CONFIG\" docker logout ghcr.io >/dev/null 2>&1 || true; sudo rm -rf \"\$DOCKER_CONFIG\" /tmp/ai-trading-deploy; }; trap cleanup EXIT; sudo install -d -o root -g root -m 0700 \"\$DOCKER_CONFIG\"; printf '%s' \"\$GH_TOKEN\" | sudo env DOCKER_CONFIG=\"\$DOCKER_CONFIG\" docker login ghcr.io --username '$GHCR_USER' --password-stdin; sudo install -d -m 0755 /opt/family-app/ai-trading; sudo install -o root -g root -m 0644 /tmp/ai-trading-deploy/docker-compose.yml /opt/family-app/ai-trading/docker-compose.yml; sudo install -o root -g root -m 0755 /tmp/ai-trading-deploy/deploy.sh /opt/family-app/ai-trading/deploy.sh; sudo install -o root -g root -m 0755 /tmp/ai-trading-deploy/health-check.sh /opt/family-app/ai-trading/health-check.sh; sudo env DOCKER_CONFIG=\"\$DOCKER_CONFIG\" IMAGE_TAG='$IMAGE_TAG' /opt/family-app/ai-trading/deploy.sh"
      - name: Remove runner SSH material
        if: always()
        run: rm -f "$RUNNER_TEMP/ai-trading-deploy-key" "$RUNNER_TEMP/ai-trading-known-hosts"
```

- [ ] **Step 3: Write `.github/dependabot.yml`**

```yaml
version: 2
updates:
  # ai-trading upstream apps (git submodules under ai-trading/packages/), bundled
  # into one weekly pull request to dev.
  - package-ecosystem: gitsubmodule
    directory: /
    schedule:
      interval: weekly
      day: monday
    target-branch: dev
    commit-message:
      prefix: "chore(ai-trading)"
    groups:
      ai-trading-upstream:
        patterns:
          - "*"
```

- [ ] **Step 4: Allow Dependabot branches in expense CI**

In `.github/workflows/expense-tax-ci.yml`, step "Enforce feature source branch", replace:

```yaml
            feature/*) ;;
            *)
              echo "Pull requests to dev must originate from feature/*; got: $HEAD_REF"
```

with:

```yaml
            feature/* | dependabot/*) ;;
            *)
              echo "Pull requests to dev must originate from feature/* or dependabot/*; got: $HEAD_REF"
```

Change nothing else in that file.

- [ ] **Step 5: Verify**

```bash
docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:latest \
  .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml .github/workflows/expense-tax-ci.yml
python3 -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]; print('ok yaml')" \
  .github/dependabot.yml .github/workflows/ai-trading-ci.yml .github/workflows/ai-trading-deploy.yml
git diff --stat -- .github/workflows/expense-tax-ci.yml
```

Expected:

- no actionlint findings;
- `ok yaml` (if PyYAML is missing, run the same check through `uv run --with pyyaml python3 -c ...`);
- the expense CI diff shows `2 insertions(+), 2 deletions(-)`.
