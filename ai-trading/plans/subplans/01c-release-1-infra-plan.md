# Release 1 Infrastructure as Code: Secret Manager, GCP Identity, Zero Trust

> **Historical plan, do not re-execute.** The current Release 1 uses Firestore
> `family-config` (not the bundle below), keeps the old Secret Manager resource
> untouched, and defers Cloudflare Access/Zero Trust. See `ai-trading/AGENTS.md`,
> `ai-trading/deploy/production/README.md`, and `plans/STATUS.md` for current gates.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Tasks 9, 10, and 11 run in parallel, one subagent each; Task 12 (apply) runs with the user. Read `ai-trading/AGENTS.md` first; it binds every task.

**Goal:** Replace every manual operator step of release 1 with code. One Secret Manager bundle in `tobytran-portfolio` holds all ai-trading values. Terraform creates the GCP identities, the Zero Trust organization, the tunnel, DNS, and Access. The deploy workflow renders env files from the bundle.

**Decisions:** D11-D13 in `../STATUS.md`. User rules: no secret files inside `ai-trading/`; provisioning through shared `infrastructure/`; one shared Cloudflare token whose permissions only broaden; copy (never reuse) expense values, except the OVH SSH keys in `expense-tax-env-files`.

**Spec:** [01-release-1-hub-design.md](01-release-1-hub-design.md), section 10 (rewritten by this plan).

## Global Constraints

- GCP project `tobytran-portfolio`, number `807362265280`. Operator gcloud commands run with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`.
- Terraform state bucket: `tobytran-portfolio-tfstate`. Prefixes: `gcp/ai-trading`, `cloudflare/zero-trust`, `cloudflare/ai-trading`.
- Secrets:
  - `ai-trading-env-bundle` (labels `app=ai-trading`, `versioning=single`);
  - reused, read-only: `expense-tax-env-files` key `ovh/github-actions-expense-tax` (OVH deploy SSH key).
- Workload identity:

  | Pool (provider `github`) | Service account | Workflow it trusts |
  |---|---|---|
  | `ai-trading-deploy` | `ai-trading-deploy@tobytran-portfolio.iam.gserviceaccount.com` | `.github/workflows/ai-trading-deploy.yml` |
  | `ai-trading-terraform` | `ai-trading-terraform@tobytran-portfolio.iam.gserviceaccount.com` | `.github/workflows/ai-trading-infra.yml` |

  Each provider condition requires repository `thangtran3112/family-app`, ref `refs/heads/main`, the exact `workflow_ref` `<repo>/.github/workflows/<file>@refs/heads/main`, and environment `ai-trading-production`.
- Provider resource names: `projects/807362265280/locations/global/workloadIdentityPools/<pool>/providers/github`.
- The Cloudflare provider reads `CLOUDFLARE_API_TOKEN` from the environment. No Terraform variable holds the token.
- The repository default branch is `dev`. `workflow_run` deploys would run as `dev`, so the deploy workflow triggers on `push` to `main`.
- Never print secret values. Under GitHub Actions, the bundle tool emits `::add-mask::` for every value it reads.

## Bundle Grammar and ai-trading Sections

```
# comments and blank lines are ignored
[section-name]          # ^[a-z0-9][a-z0-9-]*$; every key belongs to a section
KEY=value               # KEY ^[A-Za-z_][A-Za-z0-9_]*$; value = rest of the line, never empty, never "replace-me", no NUL or CR
```

- Duplicate sections and duplicate keys within a section are errors.
- A section may be empty, in which case `render` writes an empty file.

| Section | Keys (initial) |
|---|---|
| `deploy` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_KNOWN_HOSTS` (one `[host]:port ssh-ed25519 ...` line) |
| `cloudflare` | `CLOUDFLARE_API_TOKEN` (copied `CLOUDFLARE_AGENT_API_TOKEN`), `TF_VAR_cloudflare_account_id`, `TF_VAR_access_allowed_emails` (JSON list on one line) |
| `tradingagents` | app env (LLM keys added later) |
| `ai-hedge-fund` | app env (LLM keys added later) |
| `vibe-trading` | `API_AUTH_KEY` plus app env |

## Bundle Tool CLI Contract (`infrastructure/secrets/env-bundle.py`)

Python 3.9+ standard library only.

| Command | Behavior |
|---|---|
| `python3 env-bundle.py [--project P] pull APP OUT_FILE` | Writes the latest `APP-env-bundle` version to `OUT_FILE` (mode 0600). |
| `python3 env-bundle.py [--project P] push APP IN_FILE` | Validates, then runs `gcloud secrets versions add`. Re-reads the new version and compares SHA-256. Destroys every other non-destroyed version, then asserts exactly one remains. Prints `pushed APP-env-bundle version N`. |
| `python3 env-bundle.py [--project P] render APP --out-dir DIR [--bundle-file F] SECTION...` | Writes `DIR/SECTION.env` (DIR mode 0700, files 0600). Fails if a requested section is missing. |
| `python3 env-bundle.py [--project P] exec APP [--bundle-file F] SECTION... -- CMD ARGS...` | Runs `CMD` with the sections' keys added to the environment (later sections win) and returns its exit code. |
| `python3 env-bundle.py [--project P] get-file SECRET KEY OUT_FILE` | Reads a JSON-map secret and writes the string at `KEY` byte-exact to `OUT_FILE` (mode 0600). |
| `python3 env-bundle.py check IN_FILE` | Validates a local file; never calls gcloud. |

- `--project` defaults to `tobytran-portfolio`.
- Every gcloud call passes `--project`.
- Outside GitHub Actions (`GITHUB_ACTIONS` not `true`), any command that calls gcloud refuses to run unless `CLOUDSDK_ACTIVE_CONFIG_NAME` is set.
- Under GitHub Actions, `render`, `exec`, and `get-file` print `::add-mask::<value>` for each value read (multi-line values: one line per non-empty line).

## Task 9: Shared Secrets Tool, State Bootstrap, GCP Identity (owns `infrastructure/secrets/**`, `infrastructure/gcp/bootstrap-state.sh`, `infrastructure/gcp/ai-trading/**`)

1. `infrastructure/secrets/env-bundle.py` per the contract above. Separate functions: `parse_bundle(text)` (returns an ordered dict of section to ordered dict of key to value, raising `BundleError` with the line number) and `render_env(section)`. A thin `gcloud(args, input=None)` wrapper uses `subprocess.run` with `check=True`, so tests can replace `gcloud` on `PATH`.
2. `infrastructure/secrets/test_env_bundle.py` (unittest). It covers:
   - grammar (sections, comments, `=` inside values, duplicate section/key errors, empty value, `replace-me`, bad key names, key before any section);
   - `render` writing exact files and modes from `--bundle-file`;
   - `exec` exposing keys to a child process and returning its exit code;
   - `get-file` byte-exactness through a fake `gcloud`;
   - `push` uploading, verifying the hash, and destroying the other versions, through a fake `gcloud` shell script placed first on `PATH` that stores versions in a temporary directory;
   - the `CLOUDSDK_ACTIVE_CONFIG_NAME` guard;
   - masking under `GITHUB_ACTIONS=true`.
3. `infrastructure/secrets/README.md`: grammar, commands, the single-version policy, the masking behavior, and the copy-not-reuse rule with the OVH-key exception.
4. `infrastructure/gcp/bootstrap-state.sh --project P --bucket B [--location us]`:
   - idempotent `gcloud storage buckets create` with uniform bucket-level access and public-access prevention, then `buckets update --versioning`;
   - the same `CLOUDSDK_ACTIVE_CONFIG_NAME` guard;
   - mirrors `infrastructure/cloudflare/expense-tax/bootstrap-state.sh`.
5. `infrastructure/gcp/ai-trading/` Terraform (`main.tf`, `variables.tf`, `outputs.tf`, `README.md`, `.terraform.lock.hcl` for linux_amd64, linux_arm64, darwin_arm64):
   - `hashicorp/google` `>= 6.0.0, < 8.0.0`; backend `gcs` prefix `gcp/ai-trading`.
   - Variables with defaults: `project_id` (`tobytran-portfolio`), `state_bucket`, `github_repository`, `github_environment`.
   - `google_project_service` (with `disable_on_destroy = false`) for secretmanager, iam, iamcredentials, sts, and cloudresourcemanager.
   - `google_secret_manager_secret` `ai-trading-env-bundle` (auto replication, labels above).
   - For each of `deploy` and `terraform`: a pool, an OIDC provider (issuer `https://token.actions.githubusercontent.com`, attribute mapping identical to expense's), a service account, and a `roles/iam.workloadIdentityUser` binding for `principalSet://iam.googleapis.com/<pool name>/attribute.repository/<repo>`.
   - Secret IAM: deploy SA `roles/secretmanager.secretAccessor` on `ai-trading-env-bundle` and on `expense-tax-env-files`; terraform SA `secretAccessor` on `ai-trading-env-bundle`.
   - Bucket IAM: terraform SA `roles/storage.objectAdmin` on the state bucket.
   - Outputs: provider names, service account emails, the secret ID, the project number.
   - README: operator apply steps. With no ADC, pass `GOOGLE_OAUTH_ACCESS_TOKEN="$(CLOUDSDK_ACTIVE_CONFIG_NAME=personal gcloud auth print-access-token)"` for both the provider and the backend.
6. Verify:
   - `python3 -m unittest infrastructure/secrets/test_env_bundle.py`;
   - shellcheck `bootstrap-state.sh`;
   - Terraform `init -backend=false`, `fmt -check`, and `validate` through `hashicorp/terraform:latest`.

   Never apply and never call real gcloud.

## Task 10: Zero Trust Root, ai-trading Cloudflare Root, Infra Workflow (owns `infrastructure/cloudflare/zero-trust/**`, `infrastructure/cloudflare/ai-trading/**`, `.github/workflows/ai-trading-infra.yml`, deletion of `.github/workflows/ai-trading-cloudflare.yml`)

1. New root `infrastructure/cloudflare/zero-trust/` (account-wide, shared):
   - `cloudflare_zero_trust_organization` with team name variable default `tobytran` (auth domain `tobytran.cloudflareaccess.com`) and session duration `720h`;
   - the one-time PIN `cloudflare_zero_trust_access_identity_provider` moved from the ai-trading root;
   - outputs `one_time_pin_idp_id` and `team_domain`;
   - backend `gcs` prefix `cloudflare/zero-trust`; provider without `api_token` (it reads `CLOUDFLARE_API_TOKEN`); variable `cloudflare_account_id`.

   Verify the organization resource schema for the locked provider version (Context7 or `gh api` against cloudflare/terraform-provider-cloudflare docs) and record whether it supports create.
2. `infrastructure/cloudflare/ai-trading/`:
   - remove the `cloudflare_api_token` variable, the identity provider resource, and the tunnel-token data source and output;
   - read the identity provider ID with `data "terraform_remote_state" "zero_trust"` (gcs; bucket `var.state_bucket`, default `tobytran-portfolio-tfstate`; prefix `cloudflare/zero-trust`);
   - add outputs `tunnel_id` and `tunnel_name`;
   - keep the ingress, DNS, policy, and application;
   - delete `bootstrap-wif.sh`;
   - rewrite the README: token policy from AGENTS.md, apply order, and local apply through `env-bundle.py exec ai-trading cloudflare -- terraform ...`.
3. `.github/workflows/ai-trading-infra.yml` replaces `ai-trading-cloudflare.yml`, which is deleted.
   - Constants in a top-level `env:` block: project, provider name of pool `ai-trading-terraform`, terraform SA email, bucket.
   - Pull request to `dev` (paths: the three roots, `infrastructure/secrets/**`, `infrastructure/gcp/bootstrap-state.sh`, the workflow):
     - a validate matrix over `infrastructure/gcp/ai-trading`, `infrastructure/cloudflare/zero-trust`, and `infrastructure/cloudflare/ai-trading` (`init -backend=false`, `fmt -check`, `validate`);
     - a job running `python3 -m unittest infrastructure/secrets/test_env_bundle.py` and shellcheck on `infrastructure/gcp/bootstrap-state.sh`.
   - Push to `main` and `workflow_dispatch`: job `plan-or-apply` with `environment: ai-trading-production`, `id-token: write`, google-github-actions/auth@v3 and setup-gcloud@v2, then for `zero-trust` followed by `ai-trading`:
     - `terraform init -backend-config=bucket=$TF_STATE_BUCKET`;
     - `python3 infrastructure/secrets/env-bundle.py exec ai-trading cloudflare -- terraform plan -out=tfplan`;
     - on dispatch with input `apply: true`, `exec ... -- terraform apply -auto-approve tfplan`;
     - remove `tfplan` (always).
   - Never upload plan files. Every checkout sets `persist-credentials: false`.
4. Verify:
   - `fmt` and `validate` for both Cloudflare roots through Docker (lock files regenerated for the three platforms);
   - actionlint on the new workflow.

## Task 11: Deploy Pipeline from the Bundle (owns `.github/workflows/ai-trading-deploy.yml`, `.github/workflows/ai-trading-ci.yml`, `ai-trading/deploy/production/**`, `ai-trading/deploy/local/**`, `ai-trading/deploy/ci/render-env.sh`, `ai-trading/.gitignore`)

1. `ai-trading/deploy/ci/render-env.sh OUT_DIR` (bash):
   - runs `python3 infrastructure/secrets/env-bundle.py render ai-trading --out-dir OUT_DIR tradingagents ai-hedge-fund vibe-trading`;
   - writes `OUT_DIR/cloudflared.env` with `TUNNEL_TOKEN=<token>`. The token comes from the Cloudflare API inside `env-bundle.py exec ai-trading cloudflare -- ...`: `GET /accounts/$TF_VAR_cloudflare_account_id/cfd_tunnel?name=ai-trading&is_deleted=false`, then `GET .../cfd_tunnel/<id>/token`, with `curl -fsS` and `jq`. Under Actions it emits `::add-mask::` for the token. Mode 0600.
2. `.github/workflows/ai-trading-deploy.yml`:
   - Triggers: `push` to `main` (paths `ai-trading/**` except plans and markdown, `.gitmodules`, the workflow, `infrastructure/secrets/**`) and `workflow_dispatch`.
   - Job `build`: checkout with submodules; buildx; bake `--load` with the CI cache overlay; `smoke-test.sh all`; GHCR login; bake `--push` with `TAG=${{ github.sha }}`.
   - Job `deploy` (`needs: build`, `environment: ai-trading-production`):
     1. WIF auth with the deploy pool and SA constants, then setup-gcloud;
     2. `render-env.sh "$RUNNER_TEMP/ai-trading-env"`;
     3. `env-bundle.py get-file expense-tax-env-files ovh/github-actions-expense-tax "$RUNNER_TEMP/ssh-key"`;
     4. `env-bundle.py exec ai-trading deploy -- ...` to write known_hosts from `VPS_KNOWN_HOSTS` and run scp/ssh with `VPS_HOST`, `VPS_PORT`, `VPS_USER`;
     5. copy the compose file, `deploy.sh`, `health-check.sh`, and the env directory to `/tmp/ai-trading-deploy/`;
     6. the remote command keeps the existing ephemeral GHCR login and adds `ENV_STAGING_DIR=/tmp/ai-trading-deploy/env` to the `deploy.sh` invocation;
     7. clean up runner material with `if: always()`.

     `IMAGE_TAG=${{ github.sha }}`.
3. `ai-trading-ci.yml`: drop the `push` to `main` trigger (deploy covers `main`); keep `pull_request` and `workflow_dispatch`.
4. `deploy.sh`: optional `ENV_STAGING_DIR`.
   - Validate each of the four staged files: lines are blank, `#` comments, or `KEY=value` with KEY `^[A-Za-z_][A-Za-z0-9_]*$` and a non-empty value; no CR or NUL.
   - Back up current files to `$SECRETS_DIR/.previous/`, then install the staged files as root:root 0600 before pulling.
   - The rollback trap restores `.previous` before redeploying the previous tag.
   - Keep the existing root/0600 checks.
5. Remove `ai-trading/deploy/production/write-secrets.sh` and `ai-trading/deploy/production/env/`.
   - In `ai-trading/.gitignore`, remove the `!frontend/lib/`-adjacent `!deploy/production/env/` negation and the `deploy/production/env/*.env` and `deploy/local/secrets/` lines. Keep `temp/`, the reference checkouts, and `!frontend/lib/`.
6. Local stack:
   - `local.env` drops `AI_TRADING_SECRETS_DIR`.
   - The README exports `AI_TRADING_SECRETS_DIR="${TMPDIR:-/tmp}/ai-trading-local-env"`, renders `tradingagents ai-hedge-fund vibe-trading` from the bundle with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`, and writes `cloudflared.env` with `TUNNEL_TOKEN=unused-locally` there.
7. Rewrite `ai-trading/deploy/production/README.md`:
   - the bootstrap sequence (bucket, GCP apply, bundle push, Zero Trust apply, ai-trading apply, release);
   - editing secrets with pull, edit, push;
   - deploy, operations, host move, acceptance checklist;
   - the token policy pointer to `ai-trading/AGENTS.md`.
8. Verify:
   - shellcheck on all changed scripts;
   - actionlint on both workflows;
   - `docker compose config` (production with a dummy secrets dir; local overlay);
   - a `deploy.sh` staged-env validation dry check that feeds a bad file and expects the refusal.

## Task 12: Apply (main session with the user)

1. `CLOUDSDK_ACTIVE_CONFIG_NAME=personal infrastructure/gcp/bootstrap-state.sh --project tobytran-portfolio --bucket tobytran-portfolio-tfstate`.
2. Apply `infrastructure/gcp/ai-trading` with the access-token environment variable.
3. Compose the first bundle without printing values:
   - `[deploy]` from the OVH facts plus `ssh-keyscan -t ed25519`;
   - `[cloudflare]` with the token copied from `expense-tax-management/.env`, the account ID from the Cloudflare API, and the allowed emails;
   - `[vibe-trading]` with a generated `API_AUTH_KEY`;
   - the app sections.

   Then `check` and `push`.
4. Apply `infrastructure/cloudflare/zero-trust` and then `infrastructure/cloudflare/ai-trading` locally through `env-bundle.py exec`. If Cloudflare refuses to enable Access through the API, or the token lacks a permission, broaden the shared token in the dashboard with the user (browser), then re-copy if needed.
5. Pull request to `dev`, merge, then a release to `main` with ai-trading paths only (explicit approval). The push runs `ai-trading-deploy`.
