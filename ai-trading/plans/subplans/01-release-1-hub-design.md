# Release 1 Design: Trading Hub MVP

Status: Approved on 2026-10-04 (decisions D8 and D9 in [STATUS.md](../STATUS.md)). Implementation plan: [01-release-1-hub-plan.md](01-release-1-hub-plan.md). Planning-time corrections are folded into sections 4.2, 6, 7.3, 8, and 10.

Related: [STATUS.md](../STATUS.md), [00-upstream-evaluation.md](00-upstream-evaluation.md), [00b-app-shell-evaluation.md](00b-app-shell-evaluation.md), [02-release-2-desk-design.md](02-release-2-desk-design.md) (our own solution, next release).

## 1. Purpose

Give both family users one private web address where they can use three open-source trading-AI apps exactly as their authors ship them.

| App | What it does | How it appears in the hub |
|---|---|---|
| TradingAgents | A team of LLM analysts debates one ticker and returns a Buy/Hold/Sell decision with a written report | Original command-line app in a browser terminal |
| ai-hedge-fund | LLM investor personas (Buffett, Munger, Graham, Lynch, Druckenmiller) and quant models run a simulated fund with backtests and an internal paper book | Original terminal UI in a browser terminal |
| Vibe-Trading | Natural-language research agent with charts, strategy backtests, and a large skill library | Original web app on its own hostname, opened from the hub |

The apps stay unmodified and updatable from upstream. The hub is also the shell that our own solution, the Family Desk, joins in release 2.

Success criteria:

1. Both users complete one run in each app from a Mac and from an iPad with a keyboard.
2. An upstream update reaches production through a reviewed submodule-bump pull request, with no edits to upstream code.
3. The stack can be rebuilt on a new host from this repository, the secrets bundle, and the runbook.

## 2. Scope

In release 1:

- Hub web app: a home page and one route per upstream app.
- The three upstream apps, built from unmodified upstream source pinned as git submodules.
- Browser terminals with one persistent session per user.
- A dedicated Cloudflare Tunnel and Cloudflare Access application, managed by Terraform.
- CI, deployment, and weekly upstream-update pull requests.
- Per-app LLM keys with provider-side monthly spend limits.
- A rebuild runbook.

Not in release 1: the Family Desk and everything it needs (API, Postgres, scheduler, IB Gateway, alerts, in-app budgets); backups; any broker connection; Vibe-Trading chat-channel bots; automatic daily ticks for ai-hedge-fund paper funds; wrapper web pages for the terminal apps; ai-hedge-fund's frozen classic web app.

## 3. Constraints

- Upstream code is never edited. Everything we add lives outside `ai-trading/packages/`.
- `family-app` is a public repository. No secrets, email addresses, balances, positions, or account numbers are committed.
- Hosting: the OVH VPS until February 2027, then a new VPS or the home Ubuntu server. Everything is infrastructure as code. Never hosted on GCP; GCS holds Terraform state only.
- No order placement: none of the apps is connected to a broker.
- LLM providers: Anthropic and OpenAI.

## 4. Architecture

```
Cloudflare Access (two allowed emails) -- Cloudflare Tunnel -- cloudflared (in our compose)

trading.tobytran.dev
  /u/tradingagents/*   --> ta-terminal   ttyd + tmux --> `tradingagents` (upstream image)
  /u/ai-hedge-fund/*   --> ahf-terminal  ttyd + tmux --> `aihf` (unmodified package)
  everything else      --> web           Next.js hub
vibe-trading.tobytran.dev
  everything           --> vibe-trading  upstream image with upstream hardening
```

### 4.1 Services

| Service | Image | Network | Initial memory limit |
|---|---|---|---|
| `web` | Built from `ai-trading/frontend` | `hub` | 256 MB |
| `ta-terminal` | Upstream TradingAgents image plus our terminal layer | `ta` | 1 GB |
| `ahf-terminal` | Our Dockerfile: unmodified ai-hedge-fund package plus the terminal layer | `ahf` | 1 GB |
| `vibe-trading` | Built from the unmodified upstream Dockerfile | `vibe` | 2 GB |
| `cloudflared` | Official image | `hub`, `ta`, `ahf`, `vibe` | 128 MB |

- No service publishes a host port; the tunnel is the only inbound path.
- Each upstream app has its own Docker network shared only with `cloudflared`, so the apps cannot reach each other or the hub.
- All networks allow outbound internet access for LLM and market-data APIs.
- Base images are pinned by digest. Memory limits are tuned after the spike.

### 4.2 Routing

Ingress rules of the remote-managed tunnel, in Terraform. The expense tunnel already uses the same `path` rule pattern.

| Hostname | Path | Service |
|---|---|---|
| `trading.tobytran.dev` | `^/u/tradingagents(/.*)?$` | `http://ta-terminal:7681` |
| `trading.tobytran.dev` | `^/u/ai-hedge-fund(/.*)?$` | `http://ahf-terminal:7681` |
| `trading.tobytran.dev` | any other path | `http://web:3000` |
| `vibe-trading.tobytran.dev` | any path | `http://vibe-trading:8899` |
| any other hostname | - | `http_status:404` |

Hostnames are Terraform variables with these defaults. Tunnel `path` values are unanchored RE2 regular expressions, so each rule is anchored.

## 5. Hub Web App

- Next.js App Router with TypeScript and Tailwind CSS, standalone output, in `ai-trading/frontend/`. Release 2 adds the Desk pages to the same app.
- No backend calls and no auth code: Cloudflare Access protects the whole hostname.
- A navigation bar on every hub page links the four apps.

| Route | Content |
|---|---|
| `/` | Four cards: Family Desk (disabled, "release 2"), TradingAgents, AI Hedge Fund, Vibe-Trading. Each card states what the app does, what it is good for, cost notes, and a device hint (terminal apps work best with a keyboard). |
| `/apps/tradingagents` | Navigation bar, a full-height iframe of `/u/tradingagents/`, and two buttons: "Open in new tab" and "Reconnect". |
| `/apps/ai-hedge-fund` | The same layout with `/u/ai-hedge-fund/`. |
| `/apps/vibe-trading` | A short intro, an "Open Vibe-Trading" button that opens a new tab (URL from the build-time variable `NEXT_PUBLIC_VIBE_TRADING_URL`), and a first-visit note to paste the Vibe-Trading access key when its UI asks. |

Vibe-Trading is not embedded. It sends `Content-Security-Policy: frame-ancestors 'none'`, and its UI assumes the root path. Its security settings stay unchanged (D9).

## 6. Browser Terminals

- ttyd (MIT) serves a browser terminal (xterm.js) and runs the app command for each connection. Options: writable input, base path `/u/<app>`, origin check on websocket connections, terminal type `xterm-256color`.
- Each connection runs `session.sh`, which picks a session name and runs `tmux new-session -A -s <name> <app command>`.
  - The session name comes from the Cloudflare Access email header. ttyd's auth-header option passes it to the session script as `TTYD_USER`, truncated to 29 characters, and answers requests without the header with 407. If the spike shows this fails behind the tunnel, the hub page sends the name as a ttyd URL argument instead.
  - The name is reduced to the characters `a-z`, `0-9`, and `-`.
  - A reconnect attaches to the running session, so a long analysis survives an iPad sleeping or a network drop.
  - When the app exits, the session ends, and the next connection starts the app fresh.
- tmux is configured for 256 colors and mouse passthrough, so the Textual UI renders correctly and responds to clicks.
- ttyd runs the app command directly, never a shell.
- Terminal apps work best on a Mac or an iPad with a hardware keyboard. Menus that need arrow keys are awkward on touch.
- Shared wrapper files (`session.sh`, `tmux.conf`) live in `ai-trading/deploy/upstream/terminal/`.

## 7. Upstream Apps

### 7.1 TradingAgents

- Base image: `ai-trading/packages/trading-agents/Dockerfile`, built unmodified.
- Wrapper: `ai-trading/deploy/upstream/trading-agents/Dockerfile` starts from the base image, installs ttyd and tmux, adds the terminal files, keeps the upstream non-root user, and replaces the entrypoint with ttyd running `tradingagents`.
- Persistent volume: `/home/appuser/.tradingagents` (reports, logs, checkpoints).
- Environment:
  - provider API keys;
  - `TRADINGAGENTS_LLM_PROVIDER`, `TRADINGAGENTS_DEEP_THINK_LLM`, and `TRADINGAGENTS_QUICK_THINK_LLM`, set to a mid-tier and a low-cost model (upstream defaults are OpenAI `gpt-6-sol` and `gpt-6-luna`);
  - an optional free `FRED_API_KEY`.
- Market data comes from Yahoo Finance by default, with no key.

### 7.2 ai-hedge-fund

- There is no upstream Dockerfile. Ours, `ai-trading/deploy/upstream/ai-hedge-fund/Dockerfile`:
  - uses a Python 3.11 slim base image;
  - installs the main dependencies with Poetry from the upstream `poetry.lock`, then the package from the submodule source;
  - installs ttyd and tmux;
  - runs as a non-root user and starts ttyd running `aihf`, which opens its terminal UI.
- Persistent volume: `~/.hedge-fund` (mandates, paper funds, backtest results, caches, and keys saved from its key screen). Both users share one paper book.
- Environment: a provider API key and `HEDGE_FUND_LLM_MODEL`, set to a mid-tier model (upstream default: `claude-opus-5-5`).
- Data needs a paid Financial Datasets key. Leave it out of the environment until purchased: exported variables, even empty ones, override keys saved in the app's key screen. Once purchased, add it in the app's key screen or in the env file.

### 7.3 Vibe-Trading

- Image: `ai-trading/packages/vibe-trading/Dockerfile`, built unmodified. It serves the UI and the API on port 8899.
- The compose service mirrors the upstream hardening:
  - all capabilities dropped except `SETUID` and `SETGID`, which it uses to run LLM-written code as an unprivileged user;
  - `no-new-privileges`;
  - a read-only root filesystem, with tmpfs for `/tmp` and the cache directories;
  - a PID limit of 512;
  - named volumes for runs, sessions, uploads, swarm runs, and `/home/vibe/.vibe-trading`.
- The memory limit drops from upstream's 4 GB to 2 GB for the shared VPS.
- `API_AUTH_KEY` is a random secret. Each user pastes it once per browser, and Vibe-Trading keeps it in the browser's local storage.
- `FORWARDED_ALLOW_IPS=*` makes uvicorn trust `X-Forwarded-Proto` from the tunnel. Without it, Vibe-Trading's same-site check sees `http` on port 80 and rejects its own UI's requests. Only `cloudflared` can reach the container.
- Its settings page saves edits to `~/.vibe-trading/.env` inside the `vibe-home` volume, so our env file is input only and is not mounted.
- Not configured: broker connectors, chat channels, Ollama, and the Taiwan stock data mount.

## 8. Upstream Sync

- `ai-trading/packages/trading-agents`, `ai-hedge-fund`, and `vibe-trading` become git submodules pinned to upstream commits. `deer-flow` and `ag-ui` stay as gitignored reference checkouts.
- Files under `ai-trading/packages/` are never edited. CI fetches submodule commits from upstream, so a pointer to a commit that exists only locally fails the build.
- Dependabot (`package-ecosystem: gitsubmodule`) opens one grouped pull request per week for all three submodules. CI builds the images and runs the smoke tests in section 12. Merging deploys after the next release to `main`; reverting the bump rolls back.
- The `dev` ruleset requires expense CI's check, whose source-branch rule accepts only `feature/*`. That rule gains `dependabot/*` so the weekly pull request can merge.
- Manual bump: run `git -C ai-trading/packages/<app> fetch` and `git -C ai-trading/packages/<app> checkout <commit>`, then commit the new pointer.
- New clones use `git clone --recurse-submodules`; existing clones and worktrees run `git submodule update --init`. Expense CI is unaffected, because its checkouts do not fetch submodules.

## 9. LLM and Data Costs

- Each app gets its own keys: one Anthropic workspace and one OpenAI project per app, each with a monthly spend limit set in the provider console. Suggested start: $10 per workspace or project, $60 per month worst case. Raise limits in the console as needed.
- Default models are set in each app's env file (section 7). Users can still pick other models inside each app; the spend limit is the backstop.
- Market data: TradingAgents and Vibe-Trading use free sources by default. ai-hedge-fund needs a paid Financial Datasets key (section 7.2). The $20 per month paid-data budget in STATUS.md is reserved for the Family Desk.

## 10. Infrastructure as Code and Deployment

- `ai-trading/deploy/production/` holds:
  - `docker-compose.yml` with the five services and four networks from section 4.1;
  - `deploy.sh`, which pulls images, runs `docker compose up -d`, and waits for health;
  - `health-check.sh`;
  - `env/*.env.example` templates with variable names only;
  - `README.md` with the runbook.
- `infrastructure/cloudflare/ai-trading/`: Terraform for the remote-managed tunnel and its ingress rules, two DNS records, and a Cloudflare Access application.
  - The Access application covers both hostnames with a policy allowing two emails, one-time PIN login, and a 30-day session.
  - State goes in the existing GCS state bucket under prefix `cloudflare/ai-trading`.
  - The allowed emails come from a GitHub secret as a Terraform variable, so they never enter the repository.
- `.github/workflows/ai-trading-cloudflare.yml` follows `expense-tax-cloudflare.yml`: validate on pull requests, plan on `main`, apply on manual dispatch. Three differences:
  - It uses its own GCP workload identity (`infrastructure/cloudflare/ai-trading/bootstrap-wif.sh`), because the expense identity only trusts the expense workflow.
  - It plans and applies within one job and never uploads a plan artifact. Plan files contain variable values, and artifacts of a public repository are downloadable.
  - The API token variable is `ephemeral`, so it is stored neither in the plan nor in the state.
- The very first Terraform apply runs from the operator machine, because the stack needs a tunnel token before its first deploy.
- `.github/workflows/ai-trading-ci.yml` runs on changes under `ai-trading/`, including submodule pointers: hub lint, type check, and build; image builds; smoke tests; `docker compose config`.
- `.github/workflows/ai-trading-deploy.yml` runs on `main`:
  - pushes images to GHCR, tagged with the commit SHA;
  - copies the compose files and scripts over SSH;
  - runs `deploy.sh` and `health-check.sh`.

  Host, port, user, SSH key, and known-hosts entry come from a GitHub environment, so a host move changes secrets, not code.
- `.github/dependabot.yml` schedules weekly `gitsubmodule` updates.
- Secrets on the host live in the root-only directory `/etc/family-app/ai-trading/`, one env file per service: `tradingagents.env`, `ai-hedge-fund.env`, `vibe-trading.env`, and `cloudflared.env` (the tunnel token).
  - Each file has mode 0600 and is owned by root.
  - A documented operator script writes the files from the local secrets bundle. It rejects empty or placeholder values, because an exported empty variable overrides app defaults and saved keys.
- Releases to `main` carry ai-trading paths only (a branch from `origin/main`). Merging all of `dev` would also release undeployed expense phases.
- Runbook for a new host:
  1. Run `infrastructure/vps/bootstrap.sh --only firewall,ssh,docker`.
  2. Write the secrets with the operator script.
  3. Apply the Cloudflare Terraform workflow.
  4. Point the GitHub environment at the host and run the deploy workflow.
  5. Run the acceptance checklist in section 12.
- State: app data lives in named Docker volumes and counts as trial data. Release 1 has no backups. A host move before release 2 means a fresh start or a manual volume copy. Release 2 adds backups together with the Desk database.
- One-time manual steps:
  - create the Cloudflare Zero Trust organization (free plan; Cloudflare may require a payment method) and enable one-time PIN login;
  - create the provider workspaces, projects, keys, and spend limits.

## 11. Security

- Cloudflare Access admits only the two allowed emails on both hostnames.
- Each upstream app runs on its own network and sees only its own env file. A compromised app cannot reach the hub or the other apps, nor the Desk database and IB Gateway once release 2 adds them.
- Vibe-Trading executes LLM-written code in its own sandbox. We keep its upstream hardening, require its API key, and leave its CSP enforced.
- Terminals run the app command, not a shell, and reject cross-origin websocket connections.
- No app holds broker credentials.
- Provider keys are per app with spend limits, so a leaked key has a bounded cost and can be revoked alone.

## 12. Testing and Verification

CI smoke tests run on every image build, including Dependabot bumps:

| Image | Checks |
|---|---|
| `web` | `next build` passes; the container serves `/` and each `/apps/*` route with HTTP 200 |
| `ta-terminal` | `tradingagents --help` exits 0; ttyd serves `/u/tradingagents/` with HTTP 200 |
| `ahf-terminal` | `aihf --help` exits 0; ttyd serves `/u/ai-hedge-fund/` with HTTP 200 |
| `vibe-trading` | The container becomes healthy on `/live` with a test `API_AUTH_KEY` |

CI also runs `docker compose config` and Terraform `fmt -check` and `validate`. After each deploy, `health-check.sh` waits until every service is running and every service with a health check reports healthy. Vibe-Trading ships one; we add them for `web` and both terminals.

Acceptance checklist after the first deploy, on a Mac and on an iPad:

1. Access login works on both hostnames.
2. The hub home page and navigation work.
3. One TradingAgents analysis completes.
4. After closing the tab mid-run, reopening the TradingAgents route reattaches to the running session.
5. ai-hedge-fund opens its terminal UI and reaches either a backtest screen (with a data key) or its missing-key prompt (without one).
6. Vibe-Trading opens, accepts the access key, and answers one chat request.

## 13. Verification Spike (first implementation task)

Each check has a decided fallback.

| Check | Fallback |
|---|---|
| OVH VPS free memory, CPU, and disk with the expense stack running. The initial limits need about 4.5 GB of memory headroom, and the images about 15 GB of disk. | Lower the limits, or deploy to the home Ubuntu server with the same compose file and runbook |
| The Cloudflare Zero Trust free plan is active with one-time PIN login, and the Access session works in Safari on Mac and iPad | Stop and decide; the hub is never exposed without Access |
| The tunnel keeps the public `Host` header, passes `X-Forwarded-Proto`, and carries websockets; Vibe-Trading accepts its UI's POST requests with `FORWARDED_ALLOW_IPS=*` | Set `httpHostHeader` per ingress rule; put a small reverse proxy in front of Vibe-Trading that sets `X-Forwarded-Proto` |
| ttyd's origin check accepts the proxied origin; terminals work inside the hub iframe on Mac and iPad Safari; Textual renders through tmux; reattach works after the iPad sleeps | Drop the origin check (Access still gates); open terminals in a new tab |
| ttyd receives the Access email header as the session user | The hub page passes the session name as a URL argument |
| Anthropic workspace spend limits reject requests at the cap; how OpenAI project budgets behave | Fund the OpenAI projects with prepaid credits and auto-recharge off |
| Dependabot opens pull requests for submodules under `ai-trading/packages/` | A scheduled workflow runs `git submodule update --remote` and opens a pull request |
| Financial Datasets pricing | Run ai-hedge-fund without a data key until you choose to pay |

## 14. Release 2 Hook

The Family Desk joins this stack:

- Desk pages under `/desk` in the same Next.js app.
- A new `/api/*` ingress rule ahead of the hub catch-all.
- New `api`, `scheduler`, `postgres`, and `ib-gateway` services on networks the upstream apps cannot reach.

See [02-release-2-desk-design.md](02-release-2-desk-design.md).

## 15. Later Options

- Wrapper web pages for whichever terminal app proves valuable: touch-friendly forms and rendered reports.
- ai-hedge-fund's classic web app, frozen at commit `6c41ae8`.
- Daily `aihf paper tick` runs for deployed paper funds.
- Vibe-Trading's read-only IBKR connector, pointed at the Desk's paper gateway.
- A Vibe-Trading Telegram channel.
