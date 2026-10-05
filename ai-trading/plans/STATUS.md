# AI Trading: Status

Main tracker for the family AI trading assistant. Child plans and phase details live in `subplans/`. Scratch files go in `../temp/` (gitignored). Upstream code lives in `../packages/`: the three deployed apps become git submodules in release 1; deer-flow and AG-UI stay gitignored references.

> `family-app` is a public GitHub repository. Never commit balances, positions, account numbers, broker credentials, or API keys.

## Goal

A private web app (later iPad and iPhone) for two family users:

- Active trading support: technical-analysis Q&A, news- and earnings-driven tactical ideas, scans of preset stock and futures watchlists, backtesting, and forward-testing on an Interactive Brokers paper account.
- Long-term investing support: growth and reasonable-value sector research, covered-call Q&A, covered-call scanning and alerts for hedging and income.

Releases: release 1 (MVP) is a Trading Hub web app that runs TradingAgents, ai-hedge-fund, and Vibe-Trading unmodified. Release 2 adds our own solution, the Family Desk, as the hub's fourth app.

## Constraints

- Self-hosted on a VPS or the home Ubuntu server. Never hosted on GCP; light GCP services are allowed.
- LLMs: Anthropic and OpenAI APIs now. A self-hosted DeepSeek model is a distant later option.
- Broker access: Interactive Brokers paper account only. No access to live portfolios.
- Analysis and alerts only. The app never places orders on a live account.
- Web first; native mobile later.

## Phases

| # | Phase | Status | Detail |
|---|---|---|---|
| 0 | Upstream package evaluation | Done (2026-10-04) | [subplans/00-upstream-evaluation.md](subplans/00-upstream-evaluation.md) |
| 0b | App shell evaluation (deer-flow, AG-UI) | Done (2026-10-04) | [subplans/00b-app-shell-evaluation.md](subplans/00b-app-shell-evaluation.md) |
| 1 | Release 1 (MVP) design: Trading Hub web app running the three upstream apps unmodified | Spec written, awaiting review | [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md) |
| 2 | Release 1 implementation plan | Done (2026-10-04) | [subplans/01-release-1-hub-plan.md](subplans/01-release-1-hub-plan.md) and [subplans/01-release-1-hub-tasks/](subplans/01-release-1-hub-tasks/) |
| 3 | Release 1 build and deploy | Build done and verified locally (Tasks 0-7); pull request to `dev` open; Task 8 operator steps and first deploy pending | See "Release 1 build notes" below |
| 4 | Release 2 design: our own solution (Family Desk) as the hub's fourth app | Approved in conversation; revisit after the MVP ships | [subplans/02-release-2-desk-design.md](subplans/02-release-2-desk-design.md) |
| 5+ | Release 2 plan and build | Later | |

## Decisions

| Date | Decision | Status | Rationale |
|---|---|---|---|
| 2026-10-04 | Upstream repos live in `packages/` as gitignored git checkouts | Superseded for the three deployed apps (see the D9 row); deer-flow and AG-UI stay gitignored | Evaluate before choosing submodule, fork, or vendoring; keeps about 98 MB of third-party code out of the public repo. `git submodule add <url> <path>` reuses an existing clone. |
| 2026-10-04 | No upstream repo becomes the app base; build our own thin app and borrow modules | Accepted | Phase 0 and 0b conclusions |
| 2026-10-04 | Our solution's first slice = shared core plus thin slices for both users: one chat with TA and options tools, a daily covered-call scan with alerts, and a pre-market watchlist scan. Intraday scanning, backtesting, and paper trading come later. | Accepted; moved to release 2 | Daily and pre-market data covers both first jobs cheaply; both users get value in week one. |
| 2026-10-04 | App shell = our own thin stack: FastAPI + PydanticAI agent served over the AG-UI protocol, Next.js + assistant-ui client, Postgres, in-app scheduler and notifier. deer-flow, Vibe-Trading, TradingAgents, and ai-hedge-fund supply borrowed parts only. | Accepted | One app, one login, one database; tool results render as components; AG-UI keeps the iOS path open; no fork to merge. See [subplans/00b-app-shell-evaluation.md](subplans/00b-app-shell-evaluation.md). |
| 2026-10-04 | Market data behind a provider interface. IBKR (IB Gateway on a paper login) is the primary target for prices, option chains with greeks, IV history, and futures; free APIs cover earnings and economic calendars and act as a development fallback. Paid data budget: at most $20/month (IBKR non-professional US stock + options + CME futures bundles estimated near $15/month list; verify). | Accepted (Desk, release 2) | One official feed for all Desk data; the same gateway serves paper trading later; fits the budget. |
| 2026-10-04 | Release 1 deploys to the existing OVH VPS. The long-term host (a VPS or the home Ubuntu server) is undecided, and the OVH VPS will not be renewed after February 2027. | Accepted | Everything must be infrastructure as code so the stack can be recreated on a new VPS or the home server. Shared VPS and GCP infrastructure is centralized in `infrastructure/`. |
| 2026-10-04 | Desk features approved as designed (design section 2: data entry, morning scan, covered-call scan, chat tools, alerts, budgets). Push channel = Telegram bot direct messages per user, plus the in-app inbox. No email. | Accepted (Desk, release 2) | Free, instant iPhone pushes, no message-history limit, outbound-only in release 1. A notifier interface keeps Discord or Slack a small adapter away. |
| 2026-10-04 | Infrastructure: dedicated Cloudflare Tunnel and Cloudflare Access app in `infrastructure/cloudflare/ai-trading/` (built in release 1). For the Desk in release 2: app-owned Postgres container in the ai-trading compose, backup tooling extended with a second instance, and an in-app scheduler (the shared Temporal server is not used). | Accepted | OVH's Postgres is the hand-built expense instance and OVH ends in February 2027; the app, its database, and its tunnel connector move between hosts as one unit without touching expense production. |
| 2026-10-04 | Holdings come from a form or a CSV template with per-account tax type; auth is Cloudflare Access (two emails) with JWT verification in the API. | Accepted | No broker access needed; no auth code beyond token verification. |
| 2026-10-04 | Frontend = a Trading Hub of four apps. TradingAgents, ai-hedge-fund, and Vibe-Trading are deployed unmodified, each with its own hub route, and stay updatable from upstream. Our own solution is the fourth app. | Accepted | Both users can try the original solutions side by side, and upstream updates never require merging our changes. |
| 2026-10-04 | Release 1 (MVP) = the hub web app with the three upstream apps working. Our own solution (Family Desk) = release 2. | Accepted | Smallest useful release; it also proves the tunnel, Access, CI, and deploy pipeline on real workloads before the Desk is built. |
| 2026-10-04 | TradingAgents (CLI) and ai-hedge-fund (Textual TUI) appear in the hub as browser terminals (ttyd) embedded in their routes, with tmux sessions per user so long runs survive dropped connections. | Accepted | Exactly the original apps; upstream updates need no glue changes. Wrapper web pages remain a later option for whichever app proves valuable. |
| 2026-10-04 | D9, release 1 hub design: the three deployed apps become git submodules with weekly Dependabot bump pull requests and CI smoke tests; Vibe-Trading runs on its own hostname and opens in a new tab; each upstream app gets its own Docker network and env file; per-app provider keys with console spend limits; no backend, database, or backups in release 1. | Accepted | Upstream code and its security settings stay exactly as shipped (Vibe-Trading forbids framing); updates are reviewable and revertible; a compromised or runaway app stays contained. See [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md). |

| 2026-10-04 | ai-trading work happens in the worktree `.worktrees/ai-trading-hub` on branch `feature/ai-trading-hub`, not on `feature/toby`. | Accepted (ruling) | Another session resets `feature/toby` to `origin/dev` in the main checkout several times an hour; staged or committed ai-trading work there would be wiped or swept into its pull requests. |

## Release 1 Build Notes (2026-10-04)

- Verification on the local stack:
  - all four images build with Bake;
  - `smoke-test.sh all` passes 23/23;
  - Terraform validates;
  - compose files resolve;
  - shellcheck and actionlint are clean.
- Playwright check on the local stack:
  - hub home and routes render, and `/apps/desk` and `/apps/unknown` return 404;
  - the TradingAgents terminal reattaches after Reconnect;
  - the ai-hedge-fund terminal UI renders;
  - Vibe-Trading accepts its key in Settings > Local API access > Server API key.
- Deviations from the plan, all reviewed:
  - The terminal-tools Dockerfile needs syntax 1.12 so `TARGETARCH` expands in a `FROM` stage name, and pre-creates `/etc/ai-trading` at 0755.
  - `ai-trading/.gitignore` re-includes `frontend/lib/` and `deploy/production/env/`, which the root Python template ignores.
  - ttyd runs with `disableLeaveAlert=true`, because tmux keeps sessions alive.
  - The Cloudflare provider locks to 5.26.0.
- Accepted ceiling: ttyd truncates the Access identity to 29 characters, so the two allowed emails must differ within their first 29 characters. Plan Task 8 and the runbook both say so.

## Open Questions

- Release 1 verification spike (first implementation task): section 13 of [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md). It covers OVH headroom, the Cloudflare Zero Trust free plan, tunnel headers and websockets, terminals on iPad, per-user terminal sessions, provider spend limits, Dependabot with nested submodules, and Financial Datasets pricing.
- Release 2 verification spike (needs the account owner): section 13 of [subplans/02-release-2-desk-design.md](subplans/02-release-2-desk-design.md). It covers IBKR paper market-data sharing and concurrent sessions, subscription cost, IV history, the paper account-id prefix, unattended gateway login, the Finnhub free tier, image attachments over AG-UI, and host headroom.
- Each spike item has a decided fallback.

## Upstream Pins

| Package | Path | Commit | License | Verdict |
|---|---|---|---|---|
| TradingAgents | `packages/trading-agents` | `1394a3f72aa4` | Apache-2.0 | Deployed unmodified in the hub (browser terminal); reference for the Desk |
| ai-hedge-fund | `packages/ai-hedge-fund` | `78b779c1389e` | MIT | Deployed unmodified in the hub (browser terminal); persona prompts for the Desk later |
| Vibe-Trading | `packages/vibe-trading` | `251b094320c1` | MIT + NOTICE | Deployed unmodified in the hub (own hostname); options math, IBKR connector, and Telegram pattern adapted into the Desk |
| deer-flow | `packages/deer-flow` | `ee44d1ebc77d` | MIT | Borrow scheduler, auth, and chat UI patterns; do not fork |
| AG-UI | `packages/ag-ui` | `97f789cc1c48` | MIT | Adopt the protocol; skip CopilotKit |
