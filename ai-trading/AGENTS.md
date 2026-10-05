# ai-trading Agent Rules

## Scope

- ai-trading is a private family Trading Hub. Release 1 runs three unmodified upstream apps; release 2 adds our own Family Desk.
- Tracker: `plans/STATUS.md`. Detailed designs and plans: `plans/subplans/`. Scratch: `temp/` (gitignored).

## Secrets and Environment Values

- Every ai-trading secret and environment value lives in GCP Secret Manager, project `tobytran-portfolio`, secret `ai-trading-env-bundle`. The bundle is an INI-style blob: `[section]` headers followed by `KEY=value` lines. It keeps exactly one non-destroyed version (label `versioning=single`).
- Read and write it only with `infrastructure/secrets/env-bundle.py` (`pull`, `push`, `render`, `exec`, `get-file`, `check`).
- Never keep `.env` files, keys, or tokens inside `ai-trading/`, not even gitignored ones. Local runs render env files into a temporary directory outside the repository.
- Values that ai-trading needs from expense-tax-management (its `.env`, `.keys/`, or its Secret Manager bundle) are copied into `ai-trading-env-bundle`. ai-trading never reads expense's bundle at runtime.
- The one shared exception: the OVH SSH keys stay in `expense-tax-env-files` (a JSON map in `tobytran-portfolio`), and ai-trading reads them from there (`ovh/github-actions-expense-tax`).
- Never print, log, or commit secret values. Variable and key names are fine.

## Cloudflare API Token

- Use the single shared token `CLOUDFLARE_AGENT_API_TOKEN` for both ai-trading and expense-tax-management. Its source is `expense-tax-management/.env`; a copy lives in `ai-trading-env-bundle` as `[cloudflare] CLOUDFLARE_API_TOKEN`.
- Do not create additional or narrowly scoped Cloudflare tokens.
- Permissions may only be broadened, never restricted or reduced. If a task needs more permissions, open the Cloudflare dashboard in the browser and add the permission groups to this token with the user, then re-copy the value if Cloudflare rotates it.

## Infrastructure

- Provision every resource as code through the shared `infrastructure/` tree. Never change GCP, Cloudflare, GitHub, or VPS settings by hand in a console.

  | Path | What |
  |---|---|
  | `infrastructure/gcp/ai-trading/` | Terraform: Secret Manager bundle, workload identity pools, service accounts (operator-applied) |
  | `infrastructure/cloudflare/zero-trust/` | Terraform: account-wide Zero Trust organization and one-time PIN login |
  | `infrastructure/cloudflare/ai-trading/` | Terraform: tunnel, DNS, Access application |
  | `infrastructure/secrets/env-bundle.py` | Shared bundle tool |
  | `infrastructure/gcp/bootstrap-state.sh` | Terraform state bucket bootstrap |
  | `infrastructure/vps/bootstrap.sh` | Host bootstrap |

- Application deployment artifacts (compose file, deploy and health scripts) live in `ai-trading/deploy/`.
- The only manual steps are those with no API: Anthropic and OpenAI spend limits, and interactive logins.
- GCP commands from the operator machine must use the personal gcloud configuration: prefix them with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. The default active configuration (`chartflow`) is a work account; never touch it.

## Upstream Apps

- Never edit `packages/trading-agents`, `packages/ai-hedge-fund`, or `packages/vibe-trading` (git submodules). Wrapper Dockerfiles live in `deploy/upstream/`.
- Upstream updates arrive as a weekly grouped Dependabot pull request.

## Git

- `family-app` is a public repository: no secrets, email addresses, account numbers, or VPS addresses in commits.
- Another session resets `feature/toby` in the main checkout. Do ai-trading work in a worktree under `.worktrees/` on a `feature/*` branch, and open pull requests to `dev`.
- Releases to `main` carry ai-trading paths only (a branch from `origin/main`), with explicit user approval at that moment. Merging all of `dev` into `main` would also release undeployed expense phases.

## Verification

- Run `ai-trading/deploy/ci/smoke-test.sh all` after building images with `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` (run from the repository root).
- Run `python3 -m unittest infrastructure/secrets/test_env_bundle.py` after changing the bundle tool.
- Validate Terraform with `docker run --rm -v "$PWD":/w -w /w/<root> hashicorp/terraform:latest validate` after `init -backend=false`.
