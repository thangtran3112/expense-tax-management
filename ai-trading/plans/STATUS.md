# AI Trading: Status

Main tracker for the family AI trading assistant. Child plans and phase details live in `subplans/`. Scratch files go in `../temp/` (gitignored). The four release-1 upstream apps are pinned in `../packages/` as git submodules; deer-flow and AG-UI stay gitignored references. Release 1 is live; pending changes and rollout gates are recorded below.

> `family-app` is a public GitHub repository. Never commit balances, positions, account numbers, broker credentials, or API keys.

## Goal

A private web app (later iPad and iPhone) for two family users:

- Active trading support: technical-analysis Q&A, news- and earnings-driven tactical ideas, scans of preset stock and futures watchlists, backtesting, and forward-testing on an Interactive Brokers paper account.
- Long-term investing support: growth and reasonable-value sector research, covered-call Q&A, covered-call scanning and alerts for hedging and income.

Releases: release 1 (MVP) is a Trading Hub web app for four unmodified upstream apps: TradingAgents, ai-hedge-fund, Vibe-Trading, and experimental MiroFish. Release 2 adds our own solution, the Family Desk, as the hub's fifth app.

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
| 1 | Release 1 (MVP) design: Trading Hub web app with four upstream apps | MiroFish, static-hosting, and sync-skills addenda approved; service-controls addendum awaiting review | [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md), [subplans/01d-mirofish-hub-design.md](subplans/01d-mirofish-hub-design.md), [subplans/01e-static-hub-gcs-design.md](subplans/01e-static-hub-gcs-design.md), [subplans/01f-upstream-sync-skills-design.md](subplans/01f-upstream-sync-skills-design.md), [subplans/01g-hub-service-controls-design.md](subplans/01g-hub-service-controls-design.md) |
| 2 | Release 1 implementation plan | Original three-app plan complete; MiroFish, static hub, and sync-skill plans approved and implemented offline | [subplans/01-release-1-hub-plan.md](subplans/01-release-1-hub-plan.md) (prior scope); [subplans/01h-static-hub-clerk-implementation.md](subplans/01h-static-hub-clerk-implementation.md); [subplans/01i-mirofish-upstream-implementation.md](subplans/01i-mirofish-upstream-implementation.md); [subplans/01j-upstream-sync-skills-implementation.md](subplans/01j-upstream-sync-skills-implementation.md) |
| 3 | Release 1 build and deploy | Expanded four-app hub, static builds, Clerk/Caddy gateway, Firestore deploy wiring, and four sync skills merged to `dev` (PR #29); CI passed. GCP static buckets/reader IAM and Clerk session claims configured. **Live since 2026-10-08:** first production deploy (PRs #38-#46 to `main`) runs the hub, both terminals, and Vibe-Trading behind the Clerk/Caddy gate on `trading.tobytran.dev` / `vibe-trading.tobytran.dev`; live checks passed (401 without a session, forged identity headers stripped, signed-in terminals reach ttyd over WebSocket, expense production unaffected). Staging Worker/GCS hub and MiroFish static are uploaded; MiroFish runs on the VPS behind the same gate (staging hostname `mirofish-static` only; Zep free tier, shared OpenAI key). Vibe-Trading needs no pasted key (PR #49). All 01h Task 10 staging checks passed, including the owner-reported Safari check. Pending: public Worker cutover (Task 11, separate approval and auth-limit review), and the `common/config` stdout-mask fix (on `dev`, ships with the next expense release). | See "Release 1 build notes" and the addenda below |
| 3B | Post-MVP hub settings: turn each upstream backend on/off | Requested; written spec awaiting review; build after four-app MVP, before Family Desk | [subplans/01g-hub-service-controls-design.md](subplans/01g-hub-service-controls-design.md) |
| 4 | Release 2 design: our own solution (Family Desk) as the hub's fifth app | Approved in conversation; revisit after the MVP ships | [subplans/02-release-2-desk-design.md](subplans/02-release-2-desk-design.md) |
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
| 2026-10-04 | Infrastructure: dedicated Cloudflare Tunnel and Cloudflare Access app in `infrastructure/cloudflare/ai-trading/` (built in release 1). For the Desk in release 2: app-owned Postgres container in the ai-trading compose, backup tooling extended with a second instance, and an in-app scheduler (the shared Temporal server is not used). | Superseded for Release 1 Access only (see 2026-10-07 decision) | OVH's Postgres is the hand-built expense instance and OVH ends in February 2027; the app, its database, and its tunnel connector move between hosts as one unit without touching expense production. |
| 2026-10-04 | Holdings come from a form or a CSV template with per-account tax type; auth is Cloudflare Access (two emails) with JWT verification in the API. | Superseded for Release 1 by Clerk/Caddy | No broker access needed; no auth code beyond token verification. |
| 2026-10-04 | Frontend = a Trading Hub of four apps. TradingAgents, ai-hedge-fund, and Vibe-Trading are deployed unmodified, each with its own hub route, and stay updatable from upstream. Our own solution is the fourth app. | Accepted | Both users can try the original solutions side by side, and upstream updates never require merging our changes. |
| 2026-10-04 | Release 1 (MVP) = the hub web app with the three upstream apps working. Our own solution (Family Desk) = release 2. | Accepted; Access deferred by 2026-10-07 decision | Smallest useful release; it proves the tunnel, Clerk/Caddy, CI, and deploy pipeline on real workloads before the Desk is built. |
| 2026-10-04 | TradingAgents (CLI) and ai-hedge-fund (Textual TUI) appear in the hub as browser terminals (ttyd) embedded in their routes, with tmux sessions per user so long runs survive dropped connections. | Accepted | Exactly the original apps; upstream updates need no glue changes. Wrapper web pages remain a later option for whichever app proves valuable. |
| 2026-10-04 | D9, release 1 hub design: the three deployed apps become git submodules with weekly Dependabot bump pull requests and CI smoke tests; Vibe-Trading runs on its own hostname and opens in a new tab; each upstream app gets its own Docker network and env file; per-app provider keys with console spend limits; no backend, database, or backups in release 1. | Accepted | Upstream code and its security settings stay exactly as shipped (Vibe-Trading forbids framing); updates are reviewable and revertible; a compromised or runaway app stays contained. See [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md). |

| 2026-10-04 | ai-trading work happens in the worktree `.worktrees/ai-trading-hub` on a `feature/*` branch (currently `feature/ai-trading-access-defer`), not on `feature/toby`. | Accepted (ruling) | Another session resets `feature/toby` to `origin/dev` in the main checkout several times an hour; staged or committed ai-trading work there would be wiped or swept into its pull requests. |
| 2026-10-07 | Defer Cloudflare Access/Zero Trust from Release 1; Caddy/Clerk is the sole backend gate for all four apps, including Vibe-Trading. Keep the Zero Trust Terraform root for a separate future decision. | Accepted | First Access apply failed (403 and account not enabled); Cloudflare requires dashboard onboarding and payment details even for Free, outside this repo's IaC-only policy. Removing its Release 1 dependency leaves authenticated tunnel/Worker staging possible without changing expense infrastructure. |
| 2026-10-10 | Vibe-Trading becomes a small family-app fork (`thangtran3112/Vibe-Trading`, branch `family-app`), tracked by `packages/vibe-trading/DIVERGENCE.md`. Changes: Settings loads reasoning efforts per model (live probe) and refuses ones the model rejects; OpenAI default is `gpt-6.1-sol`; temperature, QVeris and the Tushare/Gildata/BaoStock credentials are gone from Settings. Dependabot ignores the submodule; syncs use the `sync-vibe-trading` skill. | Accepted (owner) | Upstream offered one fixed effort list for every model, so a saved `max` on `gpt-6.1-sol` (it accepts `low`, `medium`, `high`, `xhigh`) failed every run with HTTP 400. The picker and API are upstream source, so a wrapper cannot fix it. The Firestore profile must also carry an effort Sol accepts (it was `none`). |

## Release 1 Build Notes (2026-10-04)

- **Terminal/provider repair rollout in progress:** the captive launcher retains output and offers another analysis after completion, errors, or Ctrl+C; reconnect never starts another run automatically. Vibe's Firestore default is now direct OpenAI; a tested external startup wrapper fixes the misleading OpenRouter example-settings label without copying provider keys into settings. Full rebuilt-image/Caddy smoke and offline suites pass; upstream sources remain untouched. The owner's standing authorization now requires automatic `dev` merge, scoped release, deployment, and live verification after each completed phase, without another routine approval. Financial Datasets alternatives remain a separate, unapproved design discussion.

- **Verified follow-up rollout (PRs #53/#54 and #55/#57):** production images at `ee15c11` are healthy, including opt-in MiroFish. Vibe-Trading's hash-pinned native Anthropic adapter responds using the rotated shared Firestore key; all three app-container keys match the store, without being printed. The Account panel on public/staging hubs shows current Clerk name/email read-only; browser Sign out returns to login and new terminal requests return 401. Existing copied-cookie, cross-tab in-flight refresh, and open-stream expiry limits remain explicit in the runbook. Production smoke builds retain cache reads but disable optional cache uploads after a cache-export timeout blocked deployment. Public Worker cutover is still a separate approval gate.

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

- MiroFish stays upstream-source-compatible: build its original Vue client into a GCS bucket and run its unmodified Flask backend on VPS. Financial prediction is not shipped upstream. The owner approved Zep Cloud's free tier for public/non-sensitive experiments and has OpenAI/Anthropic keys (MiroFish uses OpenAI-compatible APIs directly). The submodule, backend image, and static build are implemented offline (see [subplans/01i-mirofish-upstream-implementation.md](subplans/01i-mirofish-upstream-implementation.md)); activation still needs Firestore Zep/LLM profiles and a deployed authenticated gateway. See [subplans/01d-mirofish-hub-design.md](subplans/01d-mirofish-hub-design.md).
- The owner prefers client-only frontend builds in GCS buckets: the hub and the original MiroFish UI are static, while backend, files, and SQLite state stay on VPS (except mandatory hosted Zep graph memory). GCS alone has no custom-domain HTTPS. GCP static buckets exist. Cloudflare Access is deferred. Staging spike ([subplans/01h-static-hub-clerk-implementation.md](subplans/01h-static-hub-clerk-implementation.md) Task 10, 2026-10-08): Step 1 deployed; Step 3 PASS (Chromium, signed in on `trading-static`: both terminals get WebSocket 101 through Worker → tunnel → Caddy → ttyd, after PR #45 fixed ttyd `--check-origin` rejecting Worker-proxied upgrades); Step 5 PASS (`trading-origin` and `trading-static` `/u/*` return 401 without a session, forged identity header included). Step 4 PASS (2026-10-08, after MiroFish activation: a 5 MB `probe.bin` multipart POST through `mirofish-static` → Worker → tunnel → Caddy reached Flask, which returned 400 "No documents were processed successfully"; no Zep/LLM call). Step 2 PASS (owner-reported real Safari sign-in, reload, quit/reopen, and persisted session). All staging checks passed; Task 11 still requires explicit owner approval and re-evaluation of the staging-only auth limits. Note: a deploy without `activate_mirofish=true` (including every push) stops MiroFish; re-dispatch with it after such deploys. See [subplans/01e-static-hub-gcs-design.md](subplans/01e-static-hub-gcs-design.md).
- Four project-local upstream-sync skills are implemented in `.opencode/skills/` and discoverable in OpenCode V2; when an upstream must diverge, create a fork and put `DIVERGENCE.md` **in that fork**. Do not write a local-only commit inside an upstream submodule. See [subplans/01f-upstream-sync-skills-design.md](subplans/01f-upstream-sync-skills-design.md).
- Post-MVP settings phase: either approved family user can start/stop TradingAgents, AI Hedge Fund, Vibe-Trading, or MiroFish to save VPS RAM; state persists across deploys. Static frontend remains in GCS, and a Clerk-protected VPS helper allows only these four actions without exposing Docker to the browser. See [subplans/01g-hub-service-controls-design.md](subplans/01g-hub-service-controls-design.md).
- The family-config Firestore handoff and `common/config/family_config.py` merged to `dev` in PR #23 and were integrated in PR #29. Runtime deploy scripts use Firestore profiles; gateway/Clerk profiles, VPS reader check, CI reader IAM, and Clerk `email`/`aud` claims are configured. The three upstream provider-key profiles exist (shared keys in `shared/llm`); The owner chose no Anthropic/OpenAI spend limits for now (2026-10-08). Vibe-Trading needs no pasted key: the Caddy gateway supplies its `API_AUTH_KEY` after the Clerk check (`vibe-gateway.env`, derived by `deploy.sh`). The existing transitional Secret Manager resource and its one enabled version remain untouched; do not auto-delete them.
- Release 1 verification spike (first implementation task): section 13 of [subplans/01-release-1-hub-design.md](subplans/01-release-1-hub-design.md). It covers OVH headroom, the Cloudflare Zero Trust free plan, tunnel headers and websockets, terminals on iPad, per-user terminal sessions, provider spend limits, Dependabot with nested submodules, and Financial Datasets pricing.
- Release 2 verification spike (needs the account owner): section 13 of [subplans/02-release-2-desk-design.md](subplans/02-release-2-desk-design.md). It covers IBKR paper market-data sharing and concurrent sessions, subscription cost, IV history, the paper account-id prefix, unattended gateway login, the Finnhub free tier, image attachments over AG-UI, and host headroom.
- Each spike item has a decided fallback.

## Upstream Pins

| Package | Path | Commit | License | Verdict |
|---|---|---|---|---|
| TradingAgents | `packages/trading-agents` | `1394a3f72aa4` | Apache-2.0 | Integrated unmodified into the local hub (browser terminal); reference for the Desk |
| ai-hedge-fund | `packages/ai-hedge-fund` | `78b779c1389e` | MIT | Integrated unmodified into the local hub (browser terminal); persona prompts for the Desk later |
| Vibe-Trading | `packages/vibe-trading` | `d7d09115d110` (fork `family-app`, based on upstream `251b094320c1`) | MIT + NOTICE | Small fork, see `packages/vibe-trading/DIVERGENCE.md`; own hostname; options math, IBKR connector, and Telegram pattern adapted into the Desk |
| MiroFish | `packages/mirofish` | `7657031ac01184afe2cb220f5ee3545573b5e843` | AGPL-3.0 | Unmodified Vue client built as static assets for GCS, Flask backend image built locally; financial prediction is not shipped and activation needs Zep Cloud + OpenAI-compatible LLM key |
| deer-flow | `packages/deer-flow` | `ee44d1ebc77d` | MIT | Borrow scheduler, auth, and chat UI patterns; do not fork |
| AG-UI | `packages/ag-ui` | `97f789cc1c48` | MIT | Adopt the protocol; skip CopilotKit |
