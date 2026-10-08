# Release 2 Design: Family Desk (Our Own Solution)

Status: Designed and approved in conversation on 2026-10-04 (sections 1-3, decisions D1-D7) as the first release, then moved to release 2 the same day when the Trading Hub MVP became release 1. Revisit after the MVP ships: confirm the scope, review this spec, then write its implementation plan.

Related: [STATUS.md](../STATUS.md) (decisions log), [01-release-1-hub-design.md](01-release-1-hub-design.md) (the hub this app joins), [00-upstream-evaluation.md](00-upstream-evaluation.md), [00b-app-shell-evaluation.md](00b-app-shell-evaluation.md).

## 1. Purpose and Users

The Family Desk is the Trading Hub's fifth app, next to the four upstream apps from release 1. Its first release adds **our own backend**, combining useful research-agent and data-routing ideas from TradingAgents, the investor-persona and risk logic from ai-hedge-fund, and market/option/tool patterns from Vibe-Trading. MiroFish remains a separate, unmodified simulation app; it is not a source for the Desk's trading backend. Upstream submodules continue syncing independently, and any adapted/copied code carries its license and attribution.

| User role | Style | Value in this release |
|---|---|---|
| Investor | Long-term growth and reasonable-value investing in promising sectors | Daily covered-call scan, risk alerts on open short calls, chat about options and covered calls |
| Trader | Day and swing trading of US stocks and futures | Pre-market scan of preset watchlists with levels and catalysts, chat about technical analysis and tactical ideas |

Success criteria:

1. The Trader opens the morning scan on most trading days.
2. The Investor acts on at least one covered-call alert per month.
3. No alert is wrong because of missing data: data gaps are reported in the alert, never hidden.

## 2. Scope

In release 2:

- Data entry: holdings with tax lots, open short calls, watchlists, per-position cover caps, settings.
- Morning scan (pre-market) for the Trader's watchlists.
- Covered-call scan and short-call risk alerts for the Investor's holdings.
- One chat agent with read-only market, options, and scan tools; tool results render as UI components.
- Chart-screenshot Q&A (stretch goal; moves to a follow-up release if image attachments over AG-UI are not reliable).
- Alerts in an in-app inbox and as Telegram direct messages.
- Per-run and per-user monthly LLM budgets.
- Desk services added to the release 1 stack, and encrypted backups of the Desk database.

Not in release 2: intraday scans and alerts, backtesting, IBKR paper order placement, trade-journal coach, investor-persona portfolio reviews, multi-agent committee reports, IBKR CSV import, web push, native iOS/iPadOS app.

## 3. Constraints

- Self-hosted backend with Docker on VPS; client-side hub/Desk pages are static assets in GCS. GCS also holds backups and Terraform state. No GCP application backend.
- The Desk backend runs on the same VPS as the upstream backends until February 2027, then a new VPS or the home Ubuntu server. The whole stack must stay recreatable from this repository, the approved family configuration store, and the latest backup.
- Shared VPS and GCP infrastructure lives in `infrastructure/`. App-specific deployment lives in `ai-trading/deploy/production/`.
- Broker access: Interactive Brokers paper account only. This release contains no order-placement code.
- LLMs: Anthropic and OpenAI APIs. A self-hosted DeepSeek model behind an OpenAI-compatible endpoint must be addable by configuration later.
- Paid market data: at most $20 per month.
- `family-app` is a public repository. No secrets, balances, positions, account numbers, or other personal financial data are committed.

## 4. Architecture

```
Browser --> Cloudflare Access --> cloudflared (from release 1)
  trading.tobytran.dev/api/*   --> api (FastAPI)
                                     |- /api/agent: AG-UI over SSE --> PydanticAI agent --> tools
                                     |- REST: holdings, watchlists, scans, alerts, threads, usage
  trading.tobytran.dev/desk/*  --> web (hub Next.js app; Desk pages use assistant-ui)
  scheduler (same Python image) --> jobs --> tools
  tools = core (pure functions) + data providers
  data providers --> ib-gateway (paper login, internal network only)
                 --> Finnhub and FRED (calendars, news); Yahoo (development and fallback)
  postgres <-- all state            notifier --> Telegram
```

### 4.1 Services

| Service | Image | Role |
|---|---|---|
| `web` | The hub app from release 1 (`ai-trading/frontend`) | Desk pages under `/desk`: overview, chat, morning scan, covered calls, alerts, holdings, watchlists, usage, settings. |
| `api` | Built from `ai-trading/backend` | FastAPI under `/api`: REST endpoints for dashboards and settings; `/api/agent` serves the PydanticAI agent through `AGUIAdapter`. The tunnel's `/api/*` rule keeps the browser same-origin. |
| `scheduler` | Same image as `api`, different command | Runs scheduled jobs. One instance, guarded by a Postgres advisory lock. |
| `ib-gateway` | Community IB Gateway image with IBC auto-login, pinned by digest | IBKR TWS API in paper mode with the read-only API setting enabled. No published port. |
| `postgres` | Official PostgreSQL 17 image, pinned by digest | App-owned database. No published port. Named volume. |
| `cloudflared` | From release 1 | Gains the `/api/*` ingress rule ahead of the hub catch-all. Still the only inbound path into the stack. |

Networks: `postgres` and `ib-gateway` sit on an internal `desk` network with `api` and `scheduler`. `api` also joins the hub network so `cloudflared` can reach it. The upstream app networks from release 1 cannot reach any Desk service.

### 4.2 Backend modules (`ai-trading/backend/src/ai_trading/`)

| Module | Responsibility | Depends on |
|---|---|---|
| `core/` | Pure functions, no I/O: indicators, key levels, Black-Scholes price/greeks/implied volatility, covered-call metrics and scoring, gap scoring, roll candidates, alert rules | numpy, pandas |
| `data/` | Interfaces `MarketData`, `Calendar`, `News`; adapters `ibkr` (via `ib_async`), `yahoo`, `finnhub`, `fred`; daily cache | `core` types |
| `agent/` | PydanticAI agent, system prompt, tool wrappers, per-user context, usage recording, budget checks | `core`, `data`, `db` |
| `jobs/` | Schedules, scan jobs, alert generation, dead-man checks, notifier interface and Telegram adapter | `core`, `data`, `db` |
| `api/` | FastAPI routers, Cloudflare Access JWT verification, AG-UI endpoint | all of the above |
| `db/` | SQLAlchemy models and Alembic migrations | - |

### 4.3 Rules

1. Tools return numbers with as-of timestamps and a data-quality marker (`realtime`, `delayed`, `fallback`, `unavailable`). The UI renders numbers from tool results. The LLM explains and ranks; it never computes prices, greeks, or yields itself.
2. Chat and scheduled jobs call the same tool functions: one code path, one test suite.
3. This release has no order-placement code. Later phases add paper orders behind a paper-only guard (paper gateway port and paper account-id prefix).
4. Borrowed code carries attribution headers and is listed in `ai-trading/THIRD_PARTY_NOTICES.md`.
5. All schedules use the `America/New_York` time zone and an exchange-holiday calendar. Timestamps are stored in UTC.

### 4.4 Repository layout

```
ai-trading/
  backend/              new: Python 3.12, uv: api, scheduler, agent
  frontend/             from release 1 (hub); adds Desk pages with assistant-ui and lightweight-charts
  deploy/production/    from release 1; compose gains api, scheduler, postgres, ib-gateway; adds desk.env template
  deploy/postgres/      new: idempotent role and schema init script
  plans/                STATUS.md and subplans/
  packages/             upstream submodules from release 1, plus gitignored references
  temp/                 scratch (gitignored)
infrastructure/
  cloudflare/ai-trading/   from release 1; adds the /api/* ingress rule
  backup/                  extended for a second, env-configured backup instance
.github/workflows/
  ai-trading-ci.yml        from release 1; adds backend checks and the api image
  ai-trading-deploy.yml    from release 1; deploys the new services
```

## 5. Data Layer

### 5.1 Interfaces

- `MarketData`: quote snapshots (including extended hours), bars (1 minute to 1 day, regular or extended hours), option chains with greeks, implied-volatility history, contract resolution (stocks, futures front month), dividends.
- `Calendar`: earnings dates, economic events.
- `News`: recent headlines per symbol.

### 5.2 Adapters

| Adapter | Use | Notes |
|---|---|---|
| `IbkrMarketData` | Primary source for quotes, bars, option chains with model greeks, IV history, futures, dividends | `ib_async` against the paper gateway, read-only. Respects IBKR pacing and market-data-line limits by batching. |
| `YahooMarketData` | Local development and fallback | Results are marked `fallback`. Never used for option greeks in alerts. |
| `FinnhubCalendar`, `FinnhubNews` | Earnings calendar and company headlines | Free tier. |
| `FredCalendar` | Economic release dates (CPI, employment report, GDP) | Free API key. FOMC meeting dates come from a static file in the repo, updated yearly. |

Daily bars, daily IV snapshots, and calendar events are cached in Postgres. Intraday bars are fetched on demand.

### 5.3 Data budget

Paid data stays at or below $20 per month. The expected cost is the IBKR non-professional bundles for US stocks, US options, and CME futures. The spike (section 13) confirms which IBKR login the app uses and the actual subscription cost.

## 6. Features

### 6.1 Data entry

- Accounts: label and tax type (`taxable` or `tax_advantaged`).
- Lots: account, symbol, shares, cost per share, acquired date. Entered by form or uploaded with the CSV template in `ai-trading/backend/templates/holdings.csv`.
- Open short calls: account, symbol, strike, expiry, contracts, premium received per share, opened date.
- Position rules: per-symbol maximum cover percentage (default 50%; 0% means never cover).
- Watchlists: named lists; each item is a stock symbol or a futures root (for example ES, NQ, CL, GC, MES).
- Settings: every threshold in sections 6.2-6.6, Telegram chat ID, quiet hours.

### 6.2 Morning scan (Trader)

Runs at 08:30 ET on trading days and on demand ("Run now").

Per stock:

- Gap % = (latest extended-hours price - prior close) / prior close.
- Gap in ATRs = gap / ATR(14, daily).
- Relative pre-market volume = pre-market volume up to scan time / average pre-market volume over the same window in the prior 10 sessions.
- Prior-day high, low, close; pre-market high and low.
- Trend context: price versus 20-, 50-, and 200-day moving averages; distance to 52-week high and low.
- Catalysts: earnings before today's open or after the prior close; headlines in the last 16 hours.

Per futures root (front month = the contract with the higher volume of the two nearest expiries):

- Overnight session high and low; move since prior settlement, in points and in ATRs.
- Prior regular-session high, low, close.
- Today's economic events with release times.

Default filters (settings): stocks with |gap| >= 2% or relative pre-market volume >= 2x; futures with overnight move >= 0.5 ATR. All watchlist symbols still appear in the table; filters only decide what is highlighted and sent.

Score (deterministic): stocks = |gap in ATRs| x min(relative pre-market volume, 5) x (1.5 if a catalyst exists, else 1.0); futures = |overnight move in ATRs|.

Output: a ranked table, a brief of at most 150 words written by the summary model from the structured results, an inbox alert, and a Telegram message.

### 6.3 Covered-call scan (Investor)

Runs at 15:30 ET on trading days and on demand.

Eligibility, per account and symbol: coverable contracts = max(0, floor(shares x max cover % / 100) - open short-call contracts). Example: 1,000 shares, 50% cap, 3 open contracts gives 2 more contracts.

Candidate filters (defaults, all settings):

| Filter | Default |
|---|---|
| Days to expiry | 21-45 |
| Delta | 0.15-0.30 |
| Open interest | >= 100 |
| Bid-ask spread | <= 10% of mid |
| Bid | >= $0.10 |
| Earnings before expiry | Excluded |

Metrics per candidate (premium uses the bid; mid is shown for reference):

- Premium yield = bid / spot; annualized yield = premium yield x 365 / DTE.
- Upside cap = (strike - spot) / spot.
- Return if called = (strike - spot + bid) / spot.
- Delta, used as a rough probability of finishing in the money.
- IV rank = (IV30 now - 52-week low) / (52-week high - 52-week low) x 100. IV percentile = share of the last 252 sessions with IV30 below today's value.

Flags:

- Ex-dividend date before expiry.
- Strike below the average cost basis of the account's lots.
- The taxable account holds lots under one year old (assignment could realize a short-term gain, depending on which lots are delivered).
- Shares in a tax-advantaged account are available to cover first.

Score (deterministic): 100 x min(annualized yield, 0.40) + 0.1 x IV rank - 10 per flag - 5 if the spread exceeds 5% of mid - 5 if delta exceeds 0.25. The scan keeps the top three candidates per account and symbol.

Alerts:

- Opportunity: annualized yield >= 15%, IV rank >= 50, and no flags.
- Short-call risk, for each open short call:
  - delta > 0.50;
  - spot within 2% of the strike with 7 or fewer days to expiry;
  - ex-dividend date on the next trading day while the call's extrinsic value is below the dividend (early-assignment risk);
  - an earnings date before expiry.
  
  Each risk alert lists roll candidates: same or higher strike, later expiry within 60 DTE, net credit >= $0.05 per share.
- Monday digest: open short calls expiring that week with current status.

### 6.4 Chat

One PydanticAI agent. The system prompt includes the user's role, holdings summary, and watchlist names. It instructs the model to take every number from tool results, to state as-of times and data-quality markers, to treat news text as untrusted, and to frame ideas as analysis rather than instructions.

Read-only tools:

| Tool | Returns |
|---|---|
| `quote` | Last, change, bid, ask, volume, as-of |
| `bars` | OHLCV series for a timeframe and lookback |
| `indicators` | RSI, MACD, EMA, SMA, VWAP (intraday), ATR, Bollinger Bands, relative volume |
| `key_levels` | Prior-day and pre-market or overnight levels, pivots, 52-week range, recent swing highs and lows |
| `chart` | Bars plus overlays and levels for the chart component |
| `option_chain` | Calls and puts with greeks for an expiry and strike range |
| `covered_call_candidates` | The section 6.3 scan for one symbol |
| `collar_quote` | Buy put plus sell call: net cost or credit, protected floor, capped upside |
| `iv_rank` | IV30, IV rank, IV percentile |
| `earnings_and_dividends` | Next earnings date, next ex-dividend date and amount |
| `news` | Recent headlines with sources and times |
| `economic_calendar` | Upcoming economic events |
| `scan_results` | Latest morning or covered-call scan |
| `my_holdings`, `my_watchlists`, `my_short_calls` | The user's own records |

Tool results render as components: a price chart with overlays and levels (TradingView lightweight-charts, Apache-2.0; keep its attribution notice), an option-chain table, a covered-call candidate table, a levels table, and a scan table.

Chart-screenshot Q&A: the user attaches an image; it reaches a vision-capable model as image content.

Threads are stored server-side. The client loads thread lists and history through REST; each run goes through the AG-UI endpoint with the thread ID, and the server checks thread ownership.

### 6.5 Alerts and notifications

- Alert fields: kind, severity (`info`, `opportunity`, `risk`, `system`), title, body, structured payload, dedupe key, created time, read time.
- The dedupe key (kind + symbol + contract + trading date) is unique per user, so a condition alerts at most once per day.
- Delivery: in-app inbox always; Telegram direct message through the Bot API `sendMessage` call, outbound only. The user enters their Telegram chat ID in settings; a helper command lists recent chat IDs from the bot's updates.
- Quiet hours suppress Telegram delivery (not the inbox). `risk` and `system` alerts ignore quiet hours.
- The notifier is an interface, so a Discord or Slack adapter can be added later.

### 6.6 LLM budgets and usage

- Per chat run: PydanticAI `UsageLimits` with at most 12 model requests and 60,000 total tokens.
- Per user per calendar month (America/New_York): a spending cap, default $25. Cost = recorded tokens x prices from `ai-trading/backend/config/llm_prices.yaml`.
- When a user's cap is reached, chat returns a budget message, and scan summaries switch to template text. Scans and alerts keep working.
- Model IDs live in `ai-trading/backend/config/models.yaml`: a Claude Sonnet-class model for chat, a low-cost model for summaries, and an OpenAI model as an alternative. A self-hosted OpenAI-compatible endpoint is a config entry.
- A Usage page shows month-to-date spend per model.

## 7. Data Model

| Table | Key columns |
|---|---|
| `users` | id, email (unique), display_name, role (`investor` or `trader`), telegram_chat_id, settings (jsonb) |
| `accounts` | id, user_id, label, tax_type |
| `lots` | id, account_id, symbol, shares, cost_per_share, acquired_on |
| `short_calls` | id, account_id, symbol, strike, expiry, contracts, premium_per_share, opened_on, status |
| `position_rules` | user_id, symbol, max_cover_pct |
| `watchlists` | id, user_id, name |
| `watchlist_items` | watchlist_id, symbol, asset_type (`stock` or `future`) |
| `scan_runs` | id, user_id, kind, started_at, finished_at, status (`ok`, `partial`, `failed`), skipped (jsonb), summary_text |
| `scan_results` | id, run_id, symbol, rank, score, payload (jsonb) |
| `alerts` | id, user_id, kind, severity, dedupe_key, title, body, payload (jsonb), created_at, read_at |
| `deliveries` | id, alert_id, channel, status, attempted_at, error |
| `chat_threads` | id, user_id, title, created_at |
| `chat_messages` | id, thread_id, role, content (jsonb), created_at |
| `llm_usage` | id, user_id, thread_id, purpose (`chat` or `summary`), model, input_tokens, output_tokens, cost_usd, created_at |
| `bars_daily` | symbol, date, open, high, low, close, volume |
| `iv_snapshots` | symbol, date, iv30 |
| `calendar_events` | id, kind, symbol, event_date, event_time, payload (jsonb) |

## 8. Schedules

| Job | Time (ET, trading days) |
|---|---|
| Calendar refresh | 06:00 |
| Morning scan | 08:30 |
| Covered-call scan | 15:30 |
| Daily bars and IV snapshot | 16:30 |
| Monday expiration digest | 08:00 on the first trading day of the week |
| Dead-man check | Every 15 minutes, 07:00-17:00 |

## 9. Infrastructure as Code

Release 2 extends the release 1 stack ([01-release-1-hub-design.md](01-release-1-hub-design.md), section 10).

- `ai-trading/deploy/production/docker-compose.yml` gains `api`, `scheduler`, `postgres`, and `ib-gateway` on the networks in section 4.1. No service publishes a host port; inbound traffic still arrives only through `cloudflared`. Outbound internet access is used by `api` and `scheduler` (LLM, data, and Telegram APIs) and `ib-gateway` (IBKR servers).
- `ai-trading/deploy/postgres/` holds an idempotent role and schema script (`CREATE ROLE/SCHEMA IF NOT EXISTS`) that runs at first container start. The same script can onboard the database into a shared cluster through `infrastructure/vps/apps/ai-trading.conf` during the 2027 host move; that consolidation is optional.
- `infrastructure/cloudflare/ai-trading/`: adds the `/api/*` ingress rule ahead of the hub catch-all. The tunnel, DNS records, and Access application already exist from release 1.
- `infrastructure/backup/`: extended to run a second instance with its own env file targeting the ai-trading Postgres, the same GCS bucket under an `ai-trading/` prefix, and the same `age` recipient. Expense-specific manifest fields become parameters. The restore drill covers the new database.
- `infrastructure/vps/`: unchanged. A new VPS or the home server is prepared with the existing `bootstrap.sh` (firewall, SSH hardening, Docker).
- `.github/workflows/ai-trading-ci.yml`: adds backend lint (ruff), type check, and tests, frontend component tests, and the `api` image build.
- `.github/workflows/ai-trading-deploy.yml`: also builds and deploys the `api` image, which `api` and `scheduler` share.
- Secrets: a new root-only `desk.env` (mode 0600) in `/etc/family-app/ai-trading/`, written by the release 1 operator script. It holds the Desk's own Anthropic and OpenAI keys, Finnhub and FRED keys, the Telegram bot token, IBKR paper credentials, database passwords, and the Access team domain and audience tag.
- Rebuild runbook: the release 1 runbook, plus restoring the latest Desk backup before the health check.

## 10. Security

- Cloudflare Access admits only the two users. `api` verifies the `Cf-Access-Jwt-Assertion` token (signature against the team certificates, audience tag) on every request and maps the email to a `users` row; unknown emails are rejected.
- Local development uses a development-only identity bypass that the production configuration refuses to start with.
- Desk services are unreachable from the upstream app networks (release 1 isolation).
- IB Gateway runs in paper mode with the read-only API setting. Its API port is reachable only on the internal network.
- Agent tools are read-only. Headlines and other external text are labeled untrusted in prompts.
- Holdings data is sent to the LLM provider only when a question needs it. Anthropic and OpenAI do not train on API data by default; a self-hosted model later removes this exposure.

## 11. Reliability and Error Handling

- Every scan run stores a status and a per-symbol skip list. Alerts state skipped symbols explicitly.
- IB Gateway health is checked before each job, with reconnect and exponential backoff. If IBKR is unavailable at scan time, prices come from Yahoo and are marked `fallback`; option metrics are marked `unavailable` and no opportunity or risk alert is generated from missing option data.
- The dead-man check sends a `system` alert when a scheduled scan has not completed within 20 minutes of its slot or when the gateway has been unavailable for more than 30 minutes during 07:00-17:00 ET.
- Telegram delivery failures are retried three times with backoff and recorded in `deliveries`. The inbox remains the source of truth.

## 12. Testing

- `core/`: pytest with fixed option-chain and bar fixtures. Covers greeks and implied volatility against reference values, yields, flags, eligibility math, gap math, scoring order, roll candidates, and every alert rule boundary.
- `data/`: adapter contract tests against recorded responses; no live network calls in CI. A manual smoke script exercises the paper gateway.
- `agent/`: PydanticAI test models verify tool wiring, usage limits, budget refusal, and the AG-UI event stream without paid calls.
- `api/`: FastAPI tests with a test signing key for Access JWTs; ownership checks on threads and records.
- `frontend/`: component tests for each tool-result component and one Playwright smoke test of chat and the scan pages.
- Deploy: compose validation in CI, `health-check.sh` after every deploy, and the backup restore drill including the ai-trading database.

## 13. Verification Spike (first implementation task)

Each item has a decided fallback, so the design does not change if the check fails.

| Check | Fallback |
|---|---|
| Does an IBKR paper login receive the live account's market data over the API, and does it fall back to delayed data while the same person is logged in live? | Use the paper login whose live counterpart is not used for trading during market hours (expected: the Investor's), and subscribe that live account to the needed bundles. |
| Actual monthly cost of the needed IBKR subscriptions | Drop the costliest bundle and use delayed data for that asset class, staying within $20. |
| IBKR implied-volatility history for underlyings | Store daily IV30 snapshots; label IV rank "short history" until 252 sessions and hide it before 60. |
| Paper account-id prefix | Record the observed prefix as the guard value for later phases. |
| Unattended IB Gateway login on a paper account (IBC, daily restart, weekly re-authentication) | Document the manual weekly step; the dead-man check reports a logged-out gateway. |
| Finnhub free-tier earnings calendar and company news | Earnings dates from Yahoo; headlines from IBKR's free news providers. |
| Image attachments through assistant-ui and the AG-UI runtime | Chart-screenshot Q&A moves to a follow-up release. |
| Host headroom for the added services (IB Gateway, Postgres, api, scheduler) on top of the hub and the expense stack | Move the whole ai-trading stack to the home Ubuntu server with the same compose file and runbook. |

## 14. Reuse Map

These items are adapted into the Desk's own code. The upstream apps themselves keep running unmodified in the hub.

| Source | Item | Use |
|---|---|---|
| Vibe-Trading `agent/src/quantlib/options.py` (MIT) | Black-Scholes price, greeks, implied-volatility solver | Adapted into `core/options_math.py` with attribution |
| Vibe-Trading `agent/src/trading/connectors/ibkr/local.py` (MIT) | Paper and read-only connection profiles | Reference for `data/ibkr.py` |
| Vibe-Trading `agent/src/channels/` (MIT) | Telegram delivery | Reference for the Telegram adapter |
| deer-flow `backend/app/scheduler/service.py` (MIT) | Lease-based scheduled tasks | Reference for `jobs/` |
| TradingAgents `tradingagents/memory/` (Apache-2.0) | Decision log, settlement, reflection | Later phase (trade journal) |
| ai-hedge-fund `hedge_fund/signals/` and commit `6c41ae8:src/agents/` (MIT) | Investor-persona prompts | Later phase (portfolio reviews) |
| AG-UI SDKs, PydanticAI, assistant-ui (MIT) | Protocol, agent runtime, chat UI | Dependencies |

## 15. Later Releases (release 3 and beyond; direction, not commitments)

1. Intraday scans and alerts (VWAP, opening-range breakouts, relative volume) and web push through an installable PWA.
2. Backtesting with a strategy library the LLM configures.
3. IBKR paper forward-testing behind the paper-only guard; trade-journal coach.
4. Investor-persona reviews of holdings, committee reports on demand, native iOS/iPadOS client over AG-UI.
5. Self-hosted DeepSeek on the home DGX Spark machines through the OpenAI-compatible model entry.
