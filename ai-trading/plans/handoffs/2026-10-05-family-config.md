# Handoff: move ai-trading onto Firestore family-config

**Date:** 2026-10-05
**From:** expense-tax-management session (family-config rollout)
**For:** the next ai-trading coding session
**Design:** `docs/superpowers/specs/2026-10-05-family-config-firestore-design.md`
**CLI docs:** `common/config/README.md`

## What changed

Every env value, config value, and key for every family-app app now lives in one
Firestore database. The plan to keep ai-trading values in a Secret Manager secret
`ai-trading-env-bundle` is replaced; that secret was never created. Expense Tax
already runs on the new store. ai-trading code has not been changed yet; that is
this session's job.

| Item | Value |
|---|---|
| Database | Firestore `family-config`, project `tobytran-portfolio`, `northamerica-northeast1` |
| Client access | none (deny-all Security Rules); access is IAM only |
| Writers | the owner account (gcloud configuration `personal`) |
| VPS identity | `family-config-reader@tobytran-portfolio.iam.gserviceaccount.com` with broad project roles (Firestore user, Secret Manager accessor, Storage object admin; no per-resource conditions); key installed at `/etc/family-app/config-reader.json` |
| CLI | `common/config/family_config.py` (Python 3.10+, standard library only, gcloud for tokens) |
| Rule | `expense-tax-management/AGENTS.md`, section "Env and Secrets" |

## Schema

```
shared/{group}                    values reused by several apps
  values: {NAME: string}          multi-line allowed (SSH keys)
apps/{app}/profiles/{profile}     one env set per profile
  values: {ENV_NAME: string | {ref: "shared/<group>", key?: NAME}}
flags/{flag}                      reserved for feature flags; unused
```

A reference reuses a shared value without copying it. `{ref: "shared/cloudflare"}`
uses the value with the same name; `{ref, key}` renames it. Keys only one app uses
belong in that app's profiles; no app prefix is needed.

## What already exists for ai-trading

| Target | Names (all references) |
|---|---|
| `ai-trading/deploy` | `VPS_HOST`, `VPS_PORT`, `VPS_USER` (from `shared/vps`) |
| `ai-trading/cloudflare` | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TF_VAR_cloudflare_api_token`, `TF_VAR_cloudflare_account_id`, `TF_VAR_zone_name` (from `shared/cloudflare`) |

Shared groups you can use:

| Group | Names |
|---|---|
| `shared/cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ZONE_NAME`, `CLOUDFLARE_API_TOKEN` (the single shared agent token), `CLOUDFLARE_BROAD_ACCESS_API_TOKEN`, `CLOUDFLARE_ZONE_DNS_EDIT_API_TOKEN` |
| `shared/vps` | `VPS_HOST`, `VPS_PORT`, `VPS_USER`, `VPS_IPV4_ADDRESS`, `VPS_IPV6_ADDRESS`, `VPS_SSH_KNOWN_HOSTS`, `VPS_DEPLOY_SSH_PRIVATE_KEY`/`_PUBLIC_KEY` (the GitHub Actions deploy key), `VPS_OPERATOR_SSH_PRIVATE_KEY`/`_PUBLIC_KEY` |
| `shared/vps-postgres` | `POSTGRES_SUPERUSER_PASSWORD` |
| `shared/temporal` | `TEMPORAL_DB_PASSWORD` |

Check the live state any time with `common/config/family_config.py ls` and
`common/config/family_config.py keys <target>` (names only).

## Replace `env-bundle.py`

The branch `feature/ai-trading-hub` contains `infrastructure/secrets/env-bundle.py`
and its tests. Delete them and use the shared CLI instead:

| `env-bundle.py` | `family_config.py` |
|---|---|
| `render ai-trading --out-dir DIR SECTION...` | `render ai-trading/<profile>... --out-dir DIR` (writes `DIR/<profile>.env`, `0600`) |
| `exec ai-trading SECTION... -- CMD` | `run ai-trading/<profile>... -- CMD` |
| `get-file expense-tax-env-files ovh/github-actions-expense-tax OUT` | `with-file shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY -- CMD {}`, or `get shared/vps VPS_DEPLOY_SSH_PRIVATE_KEY` |
| `pull` / `push` | `set <target> <NAME>` (stdin), `import <target> <dotenv-file>`, `link`, `unset`, or the Firestore console |
| `check` | not needed: every read validates the documents |

The CLI already masks values under GitHub Actions (`::add-mask::`), fails without
printing values, and on the laptop always uses gcloud configuration `personal`.

## Tasks for this session

1. **Create the app-secret profiles.** None of these values exist yet. The owner
   creates the LLM keys (one Anthropic workspace and one OpenAI project per app,
   with spend limits).
   - `ai-trading/tradingagents`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
     `TRADINGAGENTS_LLM_PROVIDER`, `TRADINGAGENTS_DEEP_THINK_LLM`,
     `TRADINGAGENTS_QUICK_THINK_LLM`, `FRED_API_KEY`.
   - `ai-trading/ai-hedge-fund`: `ANTHROPIC_API_KEY`, `HEDGE_FUND_LLM_MODEL`.
   - `ai-trading/vibe-trading`: `API_AUTH_KEY`, `LANGCHAIN_PROVIDER`,
     `LANGCHAIN_MODEL_NAME`, `ANTHROPIC_API_KEY`.
   - `ai-trading/cloudflare`: add `TF_VAR_access_allowed_emails` (JSON list; the two
     emails must differ within their first 29 characters).
   - The tunnel token stays fetched live from the Cloudflare API at deploy time, as
     `render-env.sh` already does. Do not store it unless that changes.
2. **Remove Secret Manager from `infrastructure/gcp/ai-trading/`.** Delete the
   `ai-trading-env-bundle` secret resource and both accessor bindings, including the
   binding on `expense-tax-env-files`; that secret was deleted on 2026-10-05. If a workflow must read Firestore in CI, grant its service account
   `roles/datastore.viewer` (or `roles/datastore.user`) on `tobytran-portfolio`. Keep IAM
   simple: project-level roles, no per-resource conditions (owner preference).
3. **Deploy like expense.** The VPS reads Firestore itself at deploy time with
   `/etc/family-app/config-reader.json`.
   - Copy `common/config/family_config.py` with the deploy files.
   - Wrap `deploy.sh` with
     `sudo env FAMILY_CONFIG_CREDENTIALS=/etc/family-app/config-reader.json <app-dir>/family_config.py render ai-trading/tradingagents ai-trading/ai-hedge-fund ai-trading/vibe-trading --out-dir <root-only dir>`
     (or `run`) so compose `env_file:` entries point at freshly rendered files.
   - Remove `write-secrets.sh` and the persistent `/etc/family-app/ai-trading/*.env`
     files.
   - Reference implementation: `.github/workflows/expense-tax-deploy.yml` and
     `expense-tax-management/deploy/production/deploy.sh`.
4. **Local runs.** Use `common/config/family_config.py render ... --out-dir <temp dir
   outside the repo>` or `run ... -- docker compose ...`. No env files in `ai-trading/`.
5. **Rewrite `ai-trading/AGENTS.md`** "Secrets and Environment Values" and "Cloudflare
   API Token" sections to point at Firestore `family-config` and the CLI. The
   single shared Cloudflare token is now `shared/cloudflare` `CLOUDFLARE_API_TOKEN`;
   its old source, `expense-tax-management/.env`, is going away.
6. **CI path filters.** Add `common/config/**` to the ai-trading CI and deploy
   workflow triggers, because the deploy copies the CLI.
7. **GitHub copies.** Keep only what CI needs, refreshed from Firestore through stdin,
   for example
   `common/config/family_config.py get shared/cloudflare CLOUDFLARE_API_TOKEN | gh secret set AI_TRADING_CLOUDFLARE_API_TOKEN --env ai-trading-production --repo thangtran3112/family-app`.

## Constraints

- Never print, log, or commit values. Names and targets are fine.
- On the laptop, never use the default gcloud configuration (`chartflow`, a work
  account); the CLI already passes `--configuration=personal`.
- The VPS key is already installed (2026-10-05). Rotate it with
  `infrastructure/gcp/family-config/install-reader-key.sh`, an owner-confirmed step.
