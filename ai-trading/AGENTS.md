# ai-trading Agent Rules

Applies to work under `ai-trading/`. Paths below are relative to the repository root, not to this directory.

## Scope

- ai-trading is a private family Trading Hub. Release 1 runs four unmodified upstream apps: TradingAgents, ai-hedge-fund, and Vibe-Trading always on; MiroFish is operator opt-in (`activate_mirofish=true` on a deploy dispatch, plus its own Firestore profile — see "Secrets and Environment Values"); once on, later deploys keep it on. Release 2 adds our own Family Desk.
- Tracker: `plans/STATUS.md`. Detailed designs and plans: `plans/subplans/`. Scratch: `temp/` (gitignored).
- Two lanes run in parallel: the open-source lane (the hub, the four upstream apps, their wrapper images, deploy, pins, sync skills) and the Family Desk lane (the Desk's design, Paper mockups, plan, and code: `plans/subplans/02*.md` and the Desk's own directories). Follow the Desk plan for anything about the Desk, including hostnames, and do not edit the other lane's files. `plans/STATUS.md` and this file are shared: keep edits small and additive, and rebase before pushing. Each lane has its own handoffs in `plans/handoffs/`: read the newest `*trading-hub*` file for the open-source lane and the newest `*desk*` file for the Desk lane.

## Hostnames

Owner decision, 2026-10-10 (Desk plan: `plans/subplans/02a-desk-v1-strategies-design.md` §8):

- `trading-hub.tobytran.dev`: the Trading Hub. It carries the registry (`/apps/*`) and the TradingAgents and ai-hedge-fund terminals (`/u/*`).
- `trading.tobytran.dev`: the Family Desk, our own solution (Release 2).
- `vibe-trading.tobytran.dev` stays a separate hostname for now. Upstream Vibe-Trading cannot run under a path prefix unmodified: its SPA and API are root-relative (`/api`, `/auth`, `/settings`, ...; the API base is a hard-coded `""`), its router has no base path, and it sends `X-Frame-Options: DENY`, so it cannot be a hub route or be framed. Making it a route would need patched upstream code or a rewriting proxy, which is the owner's decision (see `plans/STATUS.md`), not a default.
- MiroFish's public hostname is still open (`mirofish-static.tobytran.dev` is staging today).
- `tradingagents.tobytran.dev` and `ai-hedge-fund.tobytran.dev`: the two terminals, full-screen, behind the same Caddy/Clerk gate (01l). They also stay `/u/*` routes on the hub.
- The hub moved to `trading-hub.tobytran.dev` (Worker + GCS, 01l). `trading.tobytran.dev` still serves the hub from `web:3000` only until Desk Phase 4 takes it; do not link to it as the hub or put anything else there.

## Secrets and Environment Values

- Every ai-trading secret and environment value lives in one Firestore database, `family-config` (project `tobytran-portfolio`), shared with every family-app app. Full schema and CLI reference: `common/config/README.md`.
- Read and write it only with `common/config/family_config.py` (`run`, `render`, `get`, `keys`, `ls`, `set`, `unset`, `link`, `import`, `describe`, `with-file`). Every target is `shared/<group>` or `<app>/<profile>`; `run`/`render` only accept `<app>/<profile>` targets, never a bare `shared/<group>`.
- ai-trading's profiles: `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading` (the three upstream apps), `ai-trading/gateway` (the auth service's `SESSION_SIGNING_KEY`/`ALLOWED_EMAILS`/`ALLOWED_ORIGINS`/`CLERK_SECRET_KEY`), `ai-trading/clerk` (the public Clerk publishable key), `ai-trading/cloudflare` (tunnel/Terraform metadata, referencing `shared/cloudflare`), `ai-trading/deploy` (VPS connection details, referencing `shared/vps`), and `ai-trading/market-data` (01m: `MARKET_DATA_TOKEN`, which `ai-trading/ai-hedge-fund`'s `FINANCIAL_DATASETS_API_KEY` links to; `SEC_USER_AGENT`; `ALPACA_API_KEY_ID`/`ALPACA_API_SECRET_KEY` from Alpaca's free Basic plan). It must exist with `MARKET_DATA_TOKEN` before any deploy: `deploy.sh` renders it like the other core profiles. Optional `ai-trading/mirofish` exists with `ZEP_API_KEY` and `LLM_API_KEY` (the latter references `shared/llm:OPENAI_API_KEY_2`). `deploy.sh` turns MiroFish on with `MIROFISH_ACTIVATE=1` (dispatch `activate_mirofish=true`), keeps it on with `keep` (push deploys and plain dispatches) only while a `mirofish` container is running, and turns it off with `0` (dispatch `stop_mirofish=true`). A missing profile, a profile missing either required key, or a render failure leaves MiroFish disabled and logs why, without failing the other three apps' deploy.
- Never keep `.env` files, keys, or tokens inside `ai-trading/`, not even gitignored ones. Local runs render env files into a directory outside the repository.
- The frontend build needs the public Clerk publishable key (`ai-trading/clerk` profile) at build time, not deploy time, so it is copied into the **repository-scoped** (not environment-scoped) GitHub Actions variable `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`: `common/config/family_config.py get ai-trading/clerk PUBLISHABLE_KEY | gh variable set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY --repo thangtran3112/family-app` (no `--env`: the build job runs before any environment gate). It is a publishable key, not a secret, but still refresh it whenever Clerk rotates it.
- The VPS reads Firestore itself at deploy time, with the `family-config-reader` service account key at `/etc/family-app/config-reader.json` (`FAMILY_CONFIG_CREDENTIALS`). CI no longer stages the three upstream or gateway env files: on every deploy, `ai-trading/deploy/production/deploy.sh` renders `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading`, and `ai-trading/gateway` (renamed `auth.env`) straight from Firestore into a fresh root-only scratch directory under `/etc/family-app/ai-trading/`, derives `vibe-gateway.env` containing only Vibe's `API_AUTH_KEY` as `VIBE_API_AUTH_KEY`, and atomically installs/rolls back all six files including CI-staged `cloudflared.env`. The Caddy gateway supplies Vibe's key only after the Clerk check, so no browser needs a pasted key and Caddy receives no provider keys. CI itself only ever fetches the live Cloudflare tunnel token (`ai-trading/cloudflare`) and the VPS deploy SSH key plus host keys (`shared/vps` `VPS_DEPLOY_SSH_PRIVATE_KEY`, `VPS_SSH_KNOWN_HOSTS`); no upstream provider key transits CI.
- The old GCP Secret Manager secret `ai-trading-env-bundle` (`infrastructure/gcp/ai-trading/main.tf`) is **not deleted**: it still exists with its one version, and its Terraform resource and IAM bindings stay declared until an operator explicitly approves cleanup. No runtime code reads it anymore.
- Operator gates, none of which code can clear: create the `ai-trading/gateway` and `ai-trading/clerk` profiles and their real values in Firestore (production deploy and build fail until they exist); keep `shared/vps` `VPS_SSH_KNOWN_HOSTS` current, because the deploy workflow reads it directly for strict SSH host-key checking (do not link it into `ai-trading/deploy`: profile values must be single-line and known hosts are multi-line); apply the additive Terraform IAM grant (`roles/datastore.viewer`) for the CI deploy/terraform service accounts before their first live Firestore read.
- Never print, log, or commit secret values. Variable, target, and profile names are fine.
- **Sponsored LLM keys (owner decision, 2026-10-10):** `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` (exported from `~/.zshrc`, or in the `shared/llm` Firestore group) are sponsored; the owner is not billed. Use them freely for testing and live verification, real model calls included, as you judge useful. Cost is not a concern and no approval is needed. Secrecy rules still apply: read them only from the environment or `family_config.py`; never print, log, or commit them. CI still gets no provider keys (smoke tests use dummy values). This covers these two providers only, not other paid services or purchases.

## Cloudflare API Token

- Use the single shared token `shared/cloudflare` `CLOUDFLARE_API_TOKEN` for both ai-trading and expense-tax-management. The `ai-trading/cloudflare` profile references it (same name, no copy); fetch or use it only through `common/config/family_config.py` (`get shared/cloudflare CLOUDFLARE_API_TOKEN`, or `run ai-trading/cloudflare -- <cmd>`).
- Do not create a second, narrower, or app-specific Cloudflare token.
- Permissions may only be broadened, never restricted or reduced. If a task needs more permissions, open the Cloudflare dashboard in the browser and add the permission groups to this token with the user, then update `shared/cloudflare`'s stored value if Cloudflare rotates it (`printf '%s' "$NEW_VALUE" | common/config/family_config.py set shared/cloudflare CLOUDFLARE_API_TOKEN`).

## Infrastructure

- Provision every resource as code through the shared `infrastructure/` tree. Never change GCP, Cloudflare, GitHub, or VPS settings by hand in a console. The one named exception is the shared Cloudflare token's own permission scope ("Cloudflare API Token" above): that token's *value* is never generated or stored by Terraform, so widening what it's allowed to do is a dashboard action taken with the user, not a console edit to a provisioned resource.

  | Path | What |
  |---|---|
  | `infrastructure/gcp/ai-trading/` | Terraform: workload identity pools, service accounts, static-hosting buckets (operator-applied); still declares the retired `ai-trading-env-bundle` Secret Manager resource and its IAM bindings, kept until an operator approves cleanup |
  | `infrastructure/cloudflare/zero-trust/` | Terraform: account-wide Zero Trust organization and one-time PIN login (retained, not applied for Release 1) |
  | `infrastructure/cloudflare/ai-trading/` | Terraform: tunnel, DNS, staging Workers; no Access dependency in Release 1 |
  | `common/config/family_config.py` | Shared Firestore `family-config` CLI (all apps; not ai-trading-specific) |
  | `infrastructure/gcp/family-config/` | Firestore bootstrap and VPS reader-key install/rotation (operator-applied) |
  | `infrastructure/gcp/bootstrap-state.sh` | Terraform state bucket bootstrap |
  | `infrastructure/vps/bootstrap.sh` | Host bootstrap |

- Application deployment artifacts (compose file, deploy and health scripts) live in `ai-trading/deploy/`.
- The VPS is shared with the expense stack. Touch only ai-trading's own containers, images, and volumes; never run a global `docker system prune` or remove images you did not build. `deploy.sh` prunes only commit-tagged `ai-trading-*` images, and refuses to deploy below 30 GiB free.
- The only manual steps are those with no API: Anthropic and OpenAI spend limits, interactive logins, and owner-approved broadening of the shared Cloudflare token's own permission scope in the dashboard ("Cloudflare API Token" above — the token's permissions only, never DNS/Tunnel/Worker settings). Cloudflare Access onboarding requires a separate owner-approved exception and is not part of Release 1.
- GCP commands from the operator machine must use the personal gcloud configuration: prefix them with `CLOUDSDK_ACTIVE_CONFIG_NAME=personal`. The default active configuration (`chartflow`) is a work account; never touch it.

## Upstream Apps

- Never edit `packages/trading-agents`, `packages/ai-hedge-fund`, `packages/vibe-trading`, or `packages/mirofish` (git submodules). Wrapper Dockerfiles live in `deploy/upstream/`.
- Vibe's wrapper installs hash-pinned Anthropic additions without upgrading upstream's locked packages. Provider smoke must construct the actual native adapter offline; a 200 liveness response alone does not prove optional providers are installed.
- Vibe uses direct OpenAI only (`LANGCHAIN_PROVIDER=openai`, `OPENAI_BASE_URL=https://api.openai.com/v1`, `OPENAI_API_KEY -> shared/llm:OPENAI_API_KEY_1`). Do not configure OpenRouter for any ai-trading app. Its startup wrapper seeds non-secret LLM settings from Firestore-injected environment values, refuses other providers/endpoints, and requires native `VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=1` so the settings API reads keys from the environment instead of upstream's misleading example file. Upstream sources and provider pickers stay unmodified.
- Upstream updates arrive as a weekly grouped Dependabot pull request.

## Git

- `family-app` is a public repository: no secrets, email addresses, account numbers, or VPS addresses in commits.
- **Checkout (owner, 2026-10-10; root `AGENTS.md`):**
  - Main sessions work in the main checkout (`/Users/tobytran/personal/family-app`) on the local branch `feature/toby`, so the owner can review mockups and plans there.
  - Worktrees for a main session are opt-in: by default it never opens one on its own judgment, and uses one only with the owner's explicit instruction or approval (for example, for more parallelism).
  - Subagents use worktrees: under `.worktrees/`, on their own `feature/*` branches (release branches from `origin/main` included). The main session merges their branch into `feature/toby`, then removes the worktree and deletes the branch.
  - Start ai-trading opencode sessions with the working directory `ai-trading/`, not the repository root. Repository-wide commands still run from the root, for example `git -C ..` and `../common/config/family_config.py`.
  - Update `feature/toby` with `git fetch origin` and `git merge origin/dev`. ai-trading sessions never reset, rebase, or force-push it.
  - Handoffs carry only what is merged to `dev`. Never hand over a worktree, an unmerged branch, or uncommitted work. Before handing off, leave `feature/toby` merged up to `origin/dev`.
  - Open pull requests from `feature/toby` to `dev`, one per finished phase or meaningful batch, never per small task (root `AGENTS.md`, "Conserve GitHub Actions minutes").
- **Standing delivery authorization (personal project, 2026-10-10):** after completing each requested implementation phase, run verification/review, commit and push, create and merge its PR to `dev`, then release and deploy it immediately without asking for routine approval. Do not stop at a branch-choice menu, an unmerged PR, or a "ready to deploy" handoff. Monitor CI/deployment and verify the live result before reporting the phase complete.
- Releases to `main` carry only the completed phase's ai-trading paths (and its app-specific workflow changes when needed), on a branch from `origin/main`. The standing authorization above covers that scoped release; it replaces the old per-release approval gate. Never merge all of `dev` into `main`, which would also release unrelated expense phases.
- Deploys keep MiroFish in its current state (`MIROFISH_ACTIVATE=keep`); turn it on or off only with the `activate_mirofish` or `stop_mirofish` dispatch inputs. Upload static assets only when that phase changes them.
- Standing delivery authorization does not waive failing checks, secret-handling rules, destructive-operation safeguards, or scope boundaries. Report genuine blockers and fix them; do not request permission again for routine commits, PRs, merges, or deployment of the requested phase. It does not authorize unrelated features or paid-provider purchases.

## Verification

- Run `ai-trading/deploy/ci/smoke-test.sh all` after building images with `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load` (run from the repository root). This is the real-Caddy check: it proves the production auth gate (`forward_auth` → `auth:8181` → Clerk verification) actually strips a forged identity header and only accepts a verified one — the local stack's mock header (`deploy/local/README.md`) does not exercise this.
- Run `pnpm test` from `ai-trading/frontend/` after changing frontend auth or static-server code. Node 24 runs the offline auth-session and static-path tests; `.github/workflows/ai-trading-ci.yml`'s `hub` job runs them on every code PR.
- Run `ai-trading/deploy/ci/test-deploy-firestore.sh` after changing `deploy.sh` (Firestore render, atomic staging/rollback, MiroFish opt-in, old-image pruning, free-disk guard), `ai-trading/deploy/ci/test-render-env.sh` after changing `render-env.sh` (CI's own Cloudflare-tunnel-token fetch), `ai-trading/deploy/ci/upload-hub-static.test.sh` after changing the static-hub uploader, and `ai-trading/deploy/ci/upload-mirofish-static.test.sh` after changing the MiroFish static uploader. These offline tests use fakes and no live Firestore/GCP. The hub uploader test also checks real Next.js export files, so run `pnpm build` first; CI runs it in the `hub` job after the build. The other script tests run in the `scripts` job on every PR.
- Validate Terraform with `docker run --rm -v "$PWD":/w -w /w/<root> hashicorp/terraform:latest validate` after `init -backend=false`.
