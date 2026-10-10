# ai-trading Production Runbook

Release 1 runs the Trading Hub and three unmodified upstream apps on one host behind a dedicated Cloudflare Tunnel. Caddy and Clerk enforce the family session on every upstream route; Cloudflare Access is deferred. Design: `ai-trading/plans/subplans/01-release-1-hub-design.md`. Infrastructure as code: `ai-trading/plans/subplans/01c-release-1-infra-plan.md`.

| Service | Reached at | Notes |
|---|---|---|
| `web` | `https://trading.tobytran.dev/` | Hub |
| `ta-terminal` | `https://trading.tobytran.dev/u/tradingagents/` | TradingAgents in ttyd + tmux |
| `ahf-terminal` | `https://trading.tobytran.dev/u/ai-hedge-fund/` | ai-hedge-fund in ttyd + tmux |
| `vibe-trading` | `https://vibe-trading.tobytran.dev/` | Caddy-verified hub session, then upstream API key and hardening |
| `cloudflared` | outbound only | Tunnel connector |

On the host:

- `/opt/family-app/ai-trading/` holds the compose file, the scripts, `common/config/family_config.py`, `images.env`, and `last-good-tag`.
- `/etc/family-app/ai-trading/` holds one root-only env file per service, plus `.previous/` (the files from the deploy before last, restored automatically if a deploy fails).
- `/etc/family-app/config-reader.json` holds the `family-config-reader` service account key `deploy.sh` uses to render Firestore profiles straight onto the host.

Every secret and environment value lives in one Firestore database, `family-config` (project `tobytran-portfolio`), never in a file inside this repository. See `ai-trading/AGENTS.md` for the profile list and the Cloudflare token policy, and `common/config/README.md` for the schema and the `family_config.py` commands used below. The old `ai-trading-env-bundle` Secret Manager secret still exists (one retained version) but nothing reads it anymore.

## Bootstrap (once, in order)

1. State bucket: `CLOUDSDK_ACTIVE_CONFIG_NAME=personal infrastructure/gcp/bootstrap-state.sh --project tobytran-portfolio --bucket tobytran-portfolio-tfstate`.
2. Apply `infrastructure/gcp/ai-trading` (creates the `ai-trading-deploy` and `ai-trading-terraform` workload identity pools, their service accounts, the static-hosting buckets, and grants both service accounts `roles/datastore.viewer` so CI can read Firestore — one root, one operator-reviewed `terraform plan`/`apply`, not a second apply). See that root's README for the access-token apply steps. Do this before any push to `main` that would run `ai-trading-deploy.yml`/`ai-trading-infra.yml`'s Firestore reads — they fail with a permission error until this root's `datastore.viewer` grants are applied.
3. Create the `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading`, `ai-trading/gateway`, `ai-trading/clerk`, `ai-trading/cloudflare`, and `ai-trading/deploy` profiles in Firestore (see "Editing values" below); `ai-trading/cloudflare` must exist before any Terraform apply that reads Cloudflare values out of it, and before the first deploy.
4. Apply only `infrastructure/cloudflare/ai-trading` through `common/config/family_config.py run ai-trading/cloudflare -- terraform ...` (see that root's README). Zero Trust/Access requires separate future approval and onboarding.
5. Release to `main` with ai-trading paths only (never merge all of `dev` into `main`). The push runs `ai-trading-deploy`, which builds images, pushes them to GHCR, and deploys to the VPS, which renders its own env files from Firestore.

## Editing values

```bash
CLI=common/config/family_config.py
$CLI keys ai-trading/tradingagents      # names only, no values printed
printf '%s' "$NEW_VALUE" | $CLI set ai-trading/tradingagents ANTHROPIC_API_KEY
$CLI get ai-trading/clerk PUBLISHABLE_KEY   # prints one value exactly
```

LLM keys are shared: every app profile links `ANTHROPIC_API_KEY` and an `OPENAI_API_KEY_*` from `shared/llm`. No provider spend limit is set (owner decision, 2026-10-08).

Vibe-Trading uses **direct OpenAI**, never OpenRouter: its Firestore profile sets `LANGCHAIN_PROVIDER=openai`, `LANGCHAIN_MODEL_NAME=gpt-5.5`, `OPENAI_BASE_URL=https://api.openai.com/v1`, and `VIBE_TRADING_DESKTOP_SECURE_CREDENTIALS=1`; `OPENAI_API_KEY` remains linked to `shared/llm:OPENAI_API_KEY_1`. The wrapper refuses a different provider/endpoint at startup and seeds private, non-secret settings from the injected profile. Native secure-credential mode reads keys from the environment, so the UI cannot fall back to upstream's OpenRouter example and no key is copied into its settings file. Upstream's provider picker remains unmodified; switching it manually is unsupported for this deployment and the next startup restores the Firestore defaults.

The wrapper retains the optional native Anthropic adapter from `deploy/upstream/vibe-trading/requirements-anthropic.lock`, with exact versions and wheel hashes. It leaves upstream's pinned dependencies and source unchanged. The smoke test constructs both adapters offline, checks installed upstream versions, and checks that the API settings match the OpenAI environment without exposing/copying its key. On an upstream bump, regenerate the additions against that base image if compatibility changes. Do not install dependencies by hand on the running VPS.

Rotate a shared provider key with `family_config.py set shared/llm <KEY_NAME>` (value on stdin), then redeploy the apps linked to it. The retired Secret Manager bundle is not used.

## Account and sign-out

The header's Account panel shows the signed-in Clerk user's name and email read-only. There are no account-editing controls, and identity data is loaded client-side rather than embedded in GCS assets.

Sign out pauses new session exchanges, waits for an active exchange to settle, clears this browser's shared HttpOnly trading cookie through Origin-checked `POST /__auth/logout`, then ends the current Clerk session. The workspace is hidden during the action; a failed action offers Retry sign out instead of reporting success. Other family apps using that same Clerk session may also become signed out; this does not sign out the Google account itself.

This is browser-cookie cleanup, not server-side revocation: copied stateless cookies can remain valid until their one-hour expiry, and already-open external WebSocket/SSE connections are not forcibly closed. The serializer is per tab; an already-started refresh in another tab can still repopulate the shared cookie. A genuinely stalled exchange can delay sign-out, because the existing serial queue never aborts an active request. Public Worker cutover still requires separate approval and review of these limits.

## Terminal analyses

TradingAgents is a one-analysis CLI, not a chat loop. The shared captive launcher keeps the tmux pane and output after normal completion, an app error, or Ctrl+C cancellation, then offers **Press Enter to start another analysis**. It never automatically retries a run or opens a shell. Reconnecting attaches to that same pane without launching another analysis; EOF closes it. The image smoke tests exercise this lifecycle for both terminal apps using dummy commands, without provider calls. Deploying new terminal images still interrupts existing panes, so wait for active analyses to finish before rollout.

## Deploy

Every push to `main` touching `ai-trading/**` (excluding `ai-trading/plans/**` and any `*.md` file), `.gitmodules`, this workflow file itself, or `common/config/**` runs `build` and `deploy` below unconditionally. A manual `workflow_dispatch` instead runs **only** the jobs whose boolean input the operator explicitly sets true on that dispatch; every input defaults to `false`, so a bare "Run workflow" click with no inputs changed runs nothing.

| Input (`workflow_dispatch`) | Default | Effect |
|---|---|---|
| `deploy_app` | `false` | Runs `build` then `deploy` (manual redeploy/rollback). Ignored on a push — push always runs both. |
| `activate_mirofish` | `false` | Adds `MIROFISH_ACTIVATE=1` to `deploy.sh`'s remote invocation. **Only takes effect when `deploy_app` is also `true`**; on a push, or a dispatch with `deploy_app=false`, this is always `0` regardless of its own value. |
| `upload_hub_static` | `false` | Runs the independent `hub-static-upload` job: builds the frontend's Next.js static export with pnpm and uploads it to the hub bucket. Never builds/pushes images, never runs `deploy`, never touches MiroFish. |
| `upload_mirofish_static` | `false` | Runs the independent `mirofish-static-upload` job: builds MiroFish's static Vue export and uploads it to its own bucket. Same isolation as `upload_hub_static`. |

1. `build`: builds and smoke-tests the images with a fake Clerk key, then builds and pushes the real images to GHCR tagged with the commit SHA, using the publishable key from the repo-scoped GitHub Actions variable `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (see `ai-trading/AGENTS.md`). Before any image in this job is built or pushed (including the fake-keyed smoke build), `ai-trading/deploy/ci/check-clerk-publishable-key.sh` fails the job closed unless that variable is a `pk_live_` key decoding to this app's own Clerk Frontend API domain — the same guard `hub-static-upload` runs before its `pnpm build`.

   Production smoke/export builds read CI layer caches but clear `cache-to` (`set: '*.cache-to='`), so optional GitHub cache uploads cannot hold up the deployment. PR CI still seeds caches. The immutable GHCR push build does not use the CI cache-export overlay. Verify the override locally with `docker buildx bake -f ai-trading/deploy/docker-bake.hcl -f ai-trading/deploy/docker-bake.ci.hcl --set '*.cache-to=' --print`: targets retain `cache-from` and have no `cache-to`.
2. `deploy` (environment `ai-trading-production`): authenticates to GCP over Workload Identity Federation (no stored key), fetches only the live Cloudflare tunnel token (`ai-trading/deploy/ci/render-env.sh`, `ai-trading/cloudflare` profile) and the VPS deploy SSH key (`shared/vps` `VPS_DEPLOY_SSH_PRIVATE_KEY`), then copies the compose files, `deploy.sh`, `health-check.sh`, `common/config/family_config.py`, and the one CI-rendered file (`cloudflared.env`) to the host and runs `deploy.sh`.

On the host, `deploy.sh` renders `ai-trading/tradingagents`, `ai-trading/ai-hedge-fund`, `ai-trading/vibe-trading`, and `ai-trading/gateway` (renamed `auth.env`) straight from Firestore with the `family-config-reader` key, validates every file (well-formed `KEY=value` lines, no empty value, no NUL or CR byte), backs up the current files to `.previous/`, derives `vibe-gateway.env` (only `VIBE_API_AUTH_KEY`, copied from `vibe-trading.env`'s `API_AUTH_KEY`, for the Caddy gateway), installs all six files (the five above, plus `cloudflared.env`, the one file CI itself staged) as `root:root 0600`, then pulls and restarts the stack. If the new tag fails to come up healthy, it restores `.previous/` and rolls back to `last-good-tag`.

### MiroFish activation (`activate_mirofish`, `stop_mirofish`)

The workflow always passes an explicit `MIROFISH_ACTIVATE` to the remote `deploy.sh` (see `ai-trading/AGENTS.md`):

- A push to `main`, or a dispatch without either input, sends `keep`: MiroFish stays on only if a `mirofish` container is running now; otherwise it stays off.
- A dispatch with `deploy_app=true` and `activate_mirofish=true` sends `1`: MiroFish is turned on.
- A dispatch with `deploy_app=true` and `stop_mirofish=true` sends `0`: MiroFish is turned off. It wins over `activate_mirofish`.

`1` and `keep` both render the `ai-trading/mirofish` Firestore profile; a malformed or absent profile leaves MiroFish disabled and logs why, without failing the other three apps' deploy (`activate_mirofish()` in `deploy.sh`). Any deploy that ends with MiroFish disabled stops and removes a running MiroFish container (`ensure_mirofish_stopped()`).

### Hub and MiroFish static uploads

Both static-upload jobs are fully independent of `build`/`deploy` and of each other: neither builds/pushes a GHCR image, runs `deploy.sh`, or changes MiroFish's activation state. Each needs its own GitHub Actions repository variable pointing at its Terraform-provisioned bucket, and both authenticate through the **same existing** `ai-trading-deploy` Workload Identity Federation pool/provider as `build`/`deploy` above — no new WIF provider or role is created.

| | Hub (`upload_hub_static`) | MiroFish (`upload_mirofish_static`) |
|---|---|---|
| Bucket repo variable | `HUB_STATIC_BUCKET` | `AI_TRADING_MIROFISH_BUCKET_NAME` |
| Copy from Terraform output | `infrastructure/gcp/ai-trading` → `hub_bucket_name` | `infrastructure/gcp/ai-trading` → `mirofish_bucket_name` |
| Upload identity (WIF service account) | `ai-trading-hub-upload@tobytran-portfolio.iam.gserviceaccount.com` | `ai-trading-mirofish-upload@tobytran-portfolio.iam.gserviceaccount.com` |
| IAM scope | `roles/storage.objectAdmin` on its own bucket only (`hub-bucket.tf`) | `roles/storage.objectAdmin` on its own bucket only (`mirofish-bucket.tf`) |
| GitHub Environment | `ai-trading-production` | `ai-trading-production` |
| Clerk claim needed | Real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` repo variable (build fails closed if unset; no fake key is ever used here) | none |
| Build method | `pnpm install --frozen-lockfile` + `pnpm build` (Next.js static export, no Docker) | `docker buildx bake` (`mirofish-frontend` target) |

**Why `environment: ai-trading-production` on both, not a per-job environment name**: `infrastructure/gcp/ai-trading/main.tf`'s WIF provider `attribute_condition` requires `assertion.environment == var.github_environment` (`ai-trading-production`) for *every* job on this pool — the job's own boolean dispatch input, not its GitHub Environment name, is what gates whether it runs. A GitHub Environment name other than `ai-trading-production` (the MiroFish job previously used `ai-trading-mirofish-upload`) makes Google's OIDC token exchange fail closed with an `invalid_target`-style error, regardless of the dispatch input. Set `HUB_STATIC_BUCKET` and `AI_TRADING_MIROFISH_BUCKET_NAME` as **repository**-scoped variables (or on the shared `ai-trading-production` environment) — either is fine, since all WIF jobs already share that one environment.

**Operator caveat**: because both upload jobs and `deploy` now share one GitHub Environment, a required-reviewer protection rule added to `ai-trading-production` applies to all three. There is no way to require approval for a MiroFish/hub static publish without also requiring it for a normal app deploy, short of applying a separate narrower rule keyed off the job name (GitHub Environments do not support that natively).

## Acceptance checklist (Mac and iPad)

1. Clerk login on the hub grants a session cookie for both hostnames; without it both terminal routes and Vibe-Trading return 401 (including the direct origin hostname). Opening Vibe-Trading directly before signing in through the hub returns 401.
2. The hub home page and navigation work.
3. One TradingAgents analysis completes.
4. After closing the tab mid-run, reopening the route reattaches to the running session.
5. ai-hedge-fund opens its terminal UI and reaches a backtest screen (with a data key) or its missing-key prompt.
6. Vibe-Trading opens with no key to paste (the gateway supplies `API_AUTH_KEY` after the Clerk check) and answers one chat request.
7. Account opens with read-only name/email on desktop and iPad; Escape closes it and restores focus. Sign out returns to Clerk sign-in, and new backend requests from that browser return 401 until signing in again.

## Operations

- Logs: `sudo docker compose -p ai-trading --env-file /opt/family-app/ai-trading/images.env -f /opt/family-app/ai-trading/docker-compose.yml logs -f <service>`
- Redeploy the current tag: rerun the `ai-trading-deploy` GitHub Actions workflow (`workflow_dispatch`, `deploy_app=true`); it re-renders the four core profiles from Firestore and redeploys `${{ github.sha }}` of the `main` branch tip. This dispatch only activates MiroFish if `activate_mirofish` is also set `true` — otherwise `MIROFISH_ACTIVATE=0` is sent even if MiroFish was active before (see "MiroFish activation" above). `deploy.sh` always requires a fresh `ENV_STAGING_DIR/cloudflared.env` and always re-renders the four core profiles on the host — there is no manual mode that reuses a stale staging directory — so a host-only, direct `deploy.sh` run needs a real `cloudflared.env` staged first; rerunning the workflow is simpler.
- Disk: one release unpacks to ~17 GB (MiroFish's backend alone is ~12 GB) and shares no layers with the previous tag. Before touching Firestore, a container, or any secret, `deploy.sh` removes every commit-tagged image in the registry's `ai-trading-*` repos except the release being deployed and `last-good-tag` (an image a container still uses is never removed; other apps' and third-party images are never touched), then stops with a clear message unless `AI_TRADING_MIN_FREE_GB` (default 30) GiB is free on `AI_TRADING_DOCKER_DATA_DIR` (default `/var/lib/docker`). That stop leaves the running release untouched. Without it, a full disk fails the pull mid-deploy and also breaks the env-file rollback (2026-10-10).
- Rotate the Vibe-Trading access key: change `API_AUTH_KEY` in `ai-trading/vibe-trading` (see "Editing values"), and rerun the deploy workflow; the gateway picks up the new key, so browsers need nothing.
- Upstream updates arrive as one grouped Dependabot pull request per week. Merge it to `dev` when CI is green, then release to `main`.

## Moving to a new host

1. Run `infrastructure/vps/bootstrap.sh --only firewall,ssh,docker` against the new host, then `infrastructure/gcp/family-config/install-reader-key.sh` to install `/etc/family-app/config-reader.json` there.
2. Update `shared/vps`'s `VPS_HOST`, `VPS_PORT`, `VPS_USER`, and `VPS_SSH_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <new-host>`) — `ai-trading/deploy` references these by name, so it needs no separate update (see "Editing values").
3. Rerun the deploy workflow.
4. Stop the stack on the old host: `sudo docker compose -p ai-trading ... down`.

App data in the Docker volumes is trial data and is not copied. Release 2 adds backups.

## Local development

See `ai-trading/deploy/local/README.md`.
