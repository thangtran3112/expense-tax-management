# Release 2 Addendum A: Family Desk v1 (Strategies, Alerts, Paper Trading)

Status: Designed and approved in conversation on 2026-10-10, section by section (scope, data architecture, hostnames and layout, mockups, reuse, spike, testing). The implementation plan is the next step. Where this addendum conflicts with [02](02-release-2-desk-design.md), this addendum wins.

Related:
- [02b-desk-market-data-options.md](02b-desk-market-data-options.md): data research and the IBKR decision
- [02-release-2-desk-design.md](02-release-2-desk-design.md): base design; still valid where unchanged
- [STATUS.md](../STATUS.md): decisions log
- Mockups: Paper file "TobyTest", page "Family Desk · R2 mockups" (https://app.paper.design/file/01M4K3AXAKQC8Z6JTW03YR5HEG)

## 1. What Changed From 02

| Topic | 02 | Desk v1 |
|---|---|---|
| Center of the product | Fixed scans and chat | **User-owned strategies.** Every alert and paper order comes from a strategy. |
| Alerts | Morning scan, covered-call scan, short-call risk | Only strategies and the system create alerts. 02's scans become built-in templates. There are no manual price alerts. |
| Orders | No order code in Release 2 | Paper orders on IBKR paper, behind a paper-only guard |
| Intraday | Out of scope | In scope: strategies evaluate on each 1-minute bar close |
| Live data | IBKR on the Investor's paper login | One dedicated IBKR data login, shared by both users across all ai-trading apps ([02b](02b-desk-market-data-options.md)) |
| Paid data cap | $20 per month | $30 per month; expected $4.50–$14.50 |
| Holdings | Form and CSV | IBKR Flex read-only import, plus form and CSV (Robinhood) |
| Roles | `investor` / `trader` | Gone. Each watchlist has a horizon and each strategy has an owner. |
| Auth | Cloudflare Access JWT | The Clerk/Caddy gate from Release 1 (STATUS, 2026-10-07) |
| Address | `trading.tobytran.dev/desk` | `trading.tobytran.dev` is the Desk; the hub moves to `trading-hub.tobytran.dev` |
| Push channel | Telegram | Telegram or Slack, chosen per user |

Still valid from 02:
- §6.3 covered-call math, filters, flags, and risk rules (now inside templates)
- §6.4 chat tools
- §6.6 LLM budgets
- §8 schedules (now template cadences)
- §11 reliability (watchdog checks)
- §12 core testing approach

## 2. Users and Goals

| User | Style | v1 value |
|---|---|---|
| Spouse | Day and one-week trades: US stocks/ETFs, ES/NQ/MES/MNQ, CL/GC. She executes in IBKR or Robinhood. | Live charts with key levels; intraday strategies that alert automatically; paper-testing her setups |
| Owner | Long-term, swing, tactical; covered calls | Long-term and options strategies that alert automatically; paper-testing covered-call and swing rules |

The two main jobs are answering investment questions (stocks, futures, options, mostly covered calls) and watching each user's own lists through their own strategies.

Success criteria:
1. Each user keeps at least one active strategy that alerts without manual setup per symbol.
2. Every alert and paper fill can be traced to a strategy version and its evidence.
3. No alert is wrong because of missing data. Gaps and delayed data are labeled, never hidden.

## 3. Scope

**Desk v1 (Release 2):**
- Strategies with a versioned spec, a builder, templates, and chat drafting.
- Automatic alerts.
- IBKR paper trading with performance per strategy.
- Watchlists (as strategy inputs).
- Ask (chat).
- Holdings import.
- Charts as context for signals.
- The data foundation from [02b](02b-desk-market-data-options.md).

**Parked, not committed:**
- **Desk v2:** automated live long-term trading.
  - Sell and roll covered calls; buy and sell long-term stocks when strategy triggers fire.
  - It starts in "propose, then confirm" mode, and later runs automatically within limits.
- **Desk v3:** automated day trading at 1–10 trades per day, with hard caps and the off switch. Never high-frequency.

**Not in v1:**
- live orders
- backtesting (the spec format leaves room for it)
- native apps
- web push
- investor-persona portfolio reports beyond the weekly review block
- IBKR CSV statements (Flex replaces them)

## 4. Strategy Model

### 4.1 Records

| Record | Meaning |
|---|---|
| Strategy | Owner, name, current stage, current version |
| Strategy version | An immutable spec. Every save creates a new version, and old signals and fills stay attributed to the version that produced them. |
| Signal | A version fired for a symbol on a bar, with its evidence (the inputs and values that made the rule true) and a data-quality label |
| Alert | A signal (or system event) delivered to a person |
| Order intent | A paper order requested by a signal, sent through an outbox |
| Fill | An IBKR execution linked back to its order intent |

### 4.2 Stages

`draft` → `alert_only` → `paper`. The owner moves a strategy between stages and must confirm the move to `paper`. Desk v2 adds `live_confirm` and `live_auto`. v1 code must not offer either.

### 4.3 Spec Format and Validation

- The spec is **JSON**, stored as JSONB in Postgres.
- YAML was rejected for two reasons:
  - YAML 1.1 parsers read `15:55` as the integer 955 and `no` as `false`.
  - The chat drafts specs with JSON-Schema-constrained output.
- **Zod v4 is the source of truth.** This mirrors `expense-tax-management/packages/contracts`:
  - A new `ai-trading/contracts` package defines `StrategySpecV1`.
  - A `generate:json-schema` script writes `strategy-spec-v1.schema.json`.
  - `datamodel-code-generator` turns that schema into Pydantic models for the Python engine.
  - A CI `check-generated` step fails on drift.
- The frontend form validates with Zod. **The API validates again on every save**, because client-side validation is a convenience, not a trust boundary.
- `schemaVersion` is a required field. A breaking change creates `StrategySpecV2` plus a migration.
- Nobody types JSON by hand. Specs come from the form builder or a chat draft. "View JSON" shows the stored spec.

Spec shape (example; field names are final in the contracts package):

```json
{
  "schemaVersion": 1,
  "name": "ORB breakout 15m",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "opening_range_high", "minutes": 15 } },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 2.0 } },
      { "op": "gt", "left": { "series": "close" }, "right": { "series": "vwap" } }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"] },
    "paperOrder": { "side": "buy", "riskUsd": 200, "stop": { "level": "premarket_high" }, "targetR": 2 }
  },
  "limits": { "maxTradesPerDay": 3, "maxOpenPositions": 2, "flatBy": "15:55", "pauseAfterDailyLossUsd": 600 }
}
```

### 4.4 Block Library (v1)

Blocks are code. Adding a block type takes a pull request that changes the Zod schema, the evaluator, and the tests together.

| Kind | Blocks |
|---|---|
| Series | close/open/high/low/volume, VWAP, EMA(n), SMA(n), RSI(n, timeframe), ATR(n), relative volume (lookback), gap %, % from 52-week high, IV30, IV rank |
| Levels | prior-day high/low/close, pre-market high/low, overnight high/low (futures), opening-range high/low (minutes), N-day high/low, support/resistance, cost basis, short-call strike |
| Conditions | `gt`, `gte`, `lt`, `lte`, `crosses_above`, `crosses_below`, `within_pct`, `all`, `any`, `not`, time window, earnings within N days, ex-dividend within N days |
| Fundamentals | forward P/E, P/E versus its 5-year median, FCF yield, revenue growth (YoY), debt/equity, position weight %, gain versus cost % |
| Options | covered-call candidates with 02 §6.3 filters, metrics, and flags; short-call risk rules (02 §6.3) |
| Review | `persona_review` (Buffett, Graham, Lynch, Munger, Druckenmiller). Weekly LLM review with output `{signal, confidence, reasoning}` and a deterministic gate on score. Counts against the LLM budget. |
| Actions | `alert` (channels, severity); `paperOrder` (side, sizing by risk $, shares, % of book, or contracts; stop; target by R or level; bracket); `paperCoveredCall` (sell by delta/DTE, close at % decay, roll rules) |
| Limits | max trades per day, max open positions, max position $, flat-by time, pause after daily loss, cooldown minutes |

Family-wide limits: at most 12 paper orders per day, plus a global off switch.

### 4.5 Templates (seeded; both users can copy and tune)

- **Intraday:**
  - opening-range breakout
  - VWAP reclaim/loss
  - pre-market high/low break
  - gap-and-go (this replaces the morning scan; runs at 08:30)
  - futures overnight-range break
  - volume spike
- **Swing:**
  - N-day breakout on volume
  - pullback to the 20/50-day average in an uptrend
  - RSI extreme reversal
- **Long-term:**
  - quality dip (drawdown plus valuation)
  - trim/rebalance (position weight, stretched valuation)
  - covered-call income (02 §6.3; runs at 15:30)
  - short-call risk (02 §6.3)
  - weekly persona review

### 4.6 Editing

- **Form builder:** Watch, When, Then, and Limits blocks (mockup D2).
- **Chat drafting:** `draft_strategy` returns a schema-valid spec and a diff against the current version. Nothing is saved until the owner confirms.
- **Version history and "View JSON"** in the builder.

## 5. Strategy Runtime

**Cadences:**

| Cadence | When it runs | Where it runs |
|---|---|---|
| `bar_close_1m` | Every 1-minute bar close | The live stream in `api` |
| `premarket_0830` | 08:30 ET | `scheduler` |
| `daily_close` | 16:30 ET, after bars are appended | `scheduler` |
| `weekly` | Monday 07:00 ET | `scheduler` |

All times are America/New_York on exchange trading days. Timestamps are stored in UTC.

**Closed bars only:**
- Rules evaluate on closed bars, so a signal never repaints.
- The signal dedupe key is (strategy version, symbol, bar time).

**Data quality:**
- Every signal carries the freshness label of its inputs (`realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable`).
- A `bar_close_1m` strategy that has no live streaming slot is marked "degraded". It still alerts, labeled delayed, but **places no paper orders**.

**Action pipeline:**
1. A signal writes its `alerts` and `order_intents` rows in one transaction (outbox).
2. The notifier sends the alerts.
3. The paper broker sends the order intents.

**Alerts:**
- They go to the in-app inbox plus each user's channel (Telegram bot message or Slack incoming webhook).
- Quiet hours apply. Risk and system alerts ignore them.
- System alerts cover:
  - gateway down
  - the weekly IBKR re-login reminder (Sunday 18:00 ET)
  - a strategy that paused itself
  - a reconciliation mismatch

**Limits:**
- A strategy that hits a limit pauses itself, with a system alert.
- The global off switch (in Settings, usable from mobile) stops all new order intents and cancels working paper orders.

## 6. Paper Trading (IBKR Paper)

- **Gateway:** IB Gateway logs into the data username's paper account, with the live data subscriptions shared to it. One session then serves both live data and paper orders. If IBKR does not allow this, the spike fallback adds a second gateway: one on the live data login (read-only) and one on paper for orders.
- **Paper-only guard (fails closed):**
  - The broker refuses any order unless the connected account ID starts with `DU` *and* the gateway is on the paper port *and* the Desk config is `paper`.
  - The guard has its own tests.
- **Orders:**
  - Limit, stop, and bracket (one-cancels-other) orders through `ib_async`.
  - `orderRef` carries the order-intent ID, which links the order to its strategy version.
  - Order intents are sent once. After a restart, the broker reconciles by `orderRef` before sending anything.
- **Fills:**
  - IBKR executions are written to `fills` (unique by execution ID).
  - Positions and P&L are computed per strategy from those fills.
  - Two strategies cannot hold the same symbol at the same time in paper (a v1 rule), so positions never net out silently.
- **Flat-by:** at a strategy's flat-by time, the broker cancels its working orders and closes its positions.
- **Reconciliation:** on every reconnect and every 15 minutes, IBKR orders and positions are compared with ours. A mismatch pauses the strategy and sends a system alert.
- **Stats:** a daily rollup per version records trades, win rate, average R, P&L, and maximum drawdown (mockups D2 and D3).
- **Layout:** Paper is a top-level tab (`/paper`). Later it becomes "Test", with Paper and Backtests sub-tabs. There is one app and one Clerk login. Safety comes from three things:
  - the stage machine
  - a permanent amber `PAPER` badge
  - (in v2) an extra confirmation step for anything live

## 7. Data Architecture

Data sources, cost, and the store layout are in [02b](02b-desk-market-data-options.md). The runtime:

| Service | Role |
|---|---|
| `ib-gateway` + IBC | The data username's paper login (section 6), on the internal network only. Order placement is enabled only because the login is paper, and every order goes through the paper guard. If the spike fallback adds a live-data gateway, that one runs with IBKR's Read-Only API setting. Up to 32 API clients: Desk `api` = 1, `scheduler` = 2, Vibe-Trading = 3 later. |
| `api` (one process) | Owns the live stream: subscriptions, 1-minute bars, SSE fan-out to browsers (at most about 4 updates per second), `bar_close_1m` evaluation, and alert delivery even with no browser open. Also serves REST, AG-UI chat, and an internal `/api/data/*`. One worker on purpose; split out a `market` service if CPU becomes the limit. |
| `scheduler` | Backfills, nightly appends, the 15-minute refresh, `premarket_0830`, `daily_close`, `weekly`, calendar and fundamentals refresh, the Flex import, and watchdog checks |
| `postgres` | All state (PostgreSQL 17) |

**Streaming slots** (IBKR's default cap is 100 live symbols per username):
- The Desk uses at most 70, in this priority order:
  1. intraday strategy universes
  2. open charts
  3. covered-call underlyings during scans
- 30 are left for Vibe-Trading and option-chain snapshots.
- Settings shows slots in use.

**Failure handling:**
- **Gateway down:**
  - Stocks fall back to delayed Alpaca data (labeled).
  - Futures show `unavailable`.
  - `bar_close_1m` strategies are degraded (no paper orders).
  - A system alert goes out.
- **Alpaca or Finnhub down:** retry with backoff, and data stays labeled stale. Nothing is silently substituted.

**Reuse by the other ai-trading apps:**
- Vibe-Trading attaches to the same gateway (spike).
- TradingAgents and Vibe-Trading get the free keys (FRED, Finnhub, Alpaca) through their Firestore profiles.
- ai-hedge-fund can use `/api/data` later by overriding its hard-coded `BASE_URL` in the wrapper image (no upstream edits; not v1).

## 8. Hostnames and App Layout

| Host | After the change |
|---|---|
| `trading.tobytran.dev` | **Family Desk**: static Next.js export from GCS through the existing Worker pattern; `/api/*` goes through the tunnel to the Desk `api` |
| `trading-hub.tobytran.dev` | **Hub**, replacing `trading-static`. The production hub moves off `trading.tobytran.dev`. Terminal pages (`/apps/*`, `/u/*`) move with it. |
| `vibe-trading.`, `mirofish.` | Unchanged |

What changes:
- Cloudflare Terraform (DNS records, Worker routes)
- Clerk allowed origins and the session cookie domain
- the `ai-trading/gateway` profile's `ALLOWED_ORIGINS`
- ttyd origin checks
- the hub registry's Desk card, which links to `trading.tobytran.dev`

Cutover order:
1. Bring up `trading-hub`.
2. Pass the existing staging checks on it.
3. Switch `trading.tobytran.dev` to the Desk.

Tabs:
- Desktop: **Today · Strategies · Paper · Ask · Watchlists · Holdings**
- Mobile: **Today · Strategies · Paper · Ask · More** (Watchlists, Holdings, Settings under More)

## 9. Data Model Additions

These add to 02 §7. The 02 `users.role` column is dropped.

| Table | Key columns |
|---|---|
| `watchlists` | 02 columns + `horizon` (`intraday`, `swing`, `long_term`) |
| `strategies` | id, owner_user_id, name, stage, current_version_id, paused_reason, created_at |
| `strategy_versions` | id, strategy_id, version, schema_version, spec (jsonb), change_note, created_by, created_at; unique (strategy_id, version) |
| `signals` | id, strategy_version_id, symbol, bar_time, evidence (jsonb), data_quality, created_at; unique (strategy_version_id, symbol, bar_time) |
| `alerts` | 02 columns + signal_id (nullable for system alerts) |
| `order_intents` | id (also the IBKR `orderRef`), signal_id, strategy_version_id, mode (`paper`), payload (jsonb), status, created_at, sent_at |
| `fills` | id, order_intent_id, exec_id (unique), symbol, side, quantity, price, commission, filled_at |
| `strategy_stats` | strategy_version_id, trade_date, trades, wins, pnl, max_drawdown |
| `holdings_imports` | id, user_id, source (`ibkr_flex`, `csv`), imported_at, status, error. Fills 02's `accounts`, `lots`, and `short_calls`. |

## 10. Security and Safety

- Clerk/Caddy gate as in Release 1. The API checks the verified identity on every request and checks ownership on strategies, threads, and holdings.
- **Who can place orders:**
  - Only the strategy runtime places orders, through the paper broker and its guard.
  - The chat agent cannot call the broker.
  - Chat edits to strategies require the owner's confirmation.
- **Secrets:** a new Firestore profile `ai-trading/desk`, written only through `common/config/family_config.py`. Key names:
  - IBKR paper login for IBC
  - Alpaca key pair
  - Finnhub and FRED keys
  - Telegram bot token
  - Slack webhook URLs
  - Desk database passwords
  - IBKR Flex tokens
  - LLM keys (linked from `shared/llm`)
  Values are never committed or logged.
- **Flex tokens** can only pull read-only reports.
- **Public repository:** no balances, positions, account numbers, or emails in commits. Mockups use made-up numbers.

## 11. Reuse Map

| Source | Item | Use |
|---|---|---|
| Vibe-Trading `agent/src/quantlib/options.py` (MIT) | Black-Scholes price, greeks, IV solver | Adapt into `core/options_math.py` with attribution |
| Vibe-Trading `agent/backtest/options_payoff.py` (MIT) | Option legs and payoff | Adapt for covered-call metrics |
| Vibe-Trading `agent/src/tools/pattern_tool.py` (MIT) | Support/resistance clustering | Adapt for the levels block |
| ai-hedge-fund `hedge_fund/risk/limits.py` (MIT) | Position clamps | Adapt for strategy limits |
| ai-hedge-fund `hedge_fund/signals/` and `6c41ae8:src/agents/` (MIT) | Persona prompts and scoring | Adapt for `persona_review` |
| ai-hedge-fund `hedge_fund/fund/spec.py`, `hedge_fund/paper/ledger.py` (MIT) | Validated spec; tamper-evident ledger with an off switch | Patterns for the spec and fills |
| Vibe-Trading `scheduled_research/executor.py`, `channels/manager.py` (MIT) | Delivery queue and channels with retry | Pattern for alert delivery |
| Vibe-Trading `live/runtime/scheduler.py`, `triggers.py` (MIT) | Session-aware triggers | Pattern for cadences |
| Vibe-Trading `agent/src/trading/connectors/ibkr/local.py` (MIT) | IBKR connection profiles | Reference for the IBKR adapter |
| TradingAgents `dataflows/router.py` (Apache-2.0) | Typed vendor-fallback errors | Pattern for `data/` interfaces |
| deer-flow notification delivery (MIT) | Secret redaction patterns | Adapt for the notifier |
| Packages | `ib_async`, `alpaca-py`, `pydantic-ai-slim[ag-ui]`, `ag-ui-protocol`, assistant-ui, lightweight-charts (Apache-2.0; keep its notice), Zod v4, datamodel-code-generator | Dependencies |

Skipped:
- Vibe-Trading's LLM-written strategy code and its sandbox (documented escape gaps; unacceptable once strategies place orders)
- anything from MiroFish (AGPL-3.0)

All adapted code carries attribution headers and is listed in the receiving package's `THIRD_PARTY_NOTICES.md` (the Desk's is `ai-trading/packages/family-desk/THIRD_PARTY_NOTICES.md`).

## 12. Verification Spike (First Implementation Task)

These replace 02 §13 where they overlap. Each item has a decided fallback, so the design does not change if a check fails.

| Check | Fallback |
|---|---|
| The data username's paper login receives shared live data, and whether it needs 2FA | Two gateways: live data login (read-only) plus paper login for orders |
| The $10 bundle waiver applies to a second username | Pay $14.50 |
| Option-chain snapshot speed under the 100-symbol cap | Spread covered-call scans over about 5 minutes; fewer candidates |
| IBKR implied-volatility history for IV rank | Store daily IV30; label IV rank "short history" until 252 sessions and hide it before 60 |
| The Vibe-Trading IBKR connector's host and port can be configured | Vibe-Trading keeps its own data |
| Host headroom for IB Gateway, Postgres, `api`, and `scheduler` on the VPS | Move the ai-trading stack to the home Ubuntu server |
| An IBKR Flex Web Service token pulls positions and open options read-only | CSV upload |
| The `trading-hub` hostname move (Clerk origins, cookies, ttyd origin) | Stay on `trading-static` until it passes on staging |
| Paper account ID prefix | Record the observed prefix as the guard value |

## 13. Testing

- **Strategy evaluation:** pure functions; golden tests on fixed bar fixtures for every template, at exact trigger boundaries (fires, does not fire, and repaint safety).
- **Contracts:** Zod and the generated Pydantic models accept and reject the same fixtures; CI fails on drift.
- **Paper broker:**
  - the guard refuses non-`DU` accounts, non-paper ports, and a non-paper config
  - order intents are never sent twice
  - fills attribute to the right strategy
  - limits pause strategies
  - the off switch cancels working orders
  - reconciliation detects mismatches
- **Data adapters:** contract tests against recorded responses; no live network calls in CI.
- **Chat:** PydanticAI test models show that `draft_strategy` only produces schema-valid specs and never saves without confirmation.
- **Frontend:** component tests for the builder, signal cards, and Paper tables; one Playwright smoke test (Today → Strategies → Paper).
- **Deploy:** compose validation, `health-check.sh`, and the backup restore drill for the Desk database (02 §12).

## 14. Build Order

Each slice ships on its own:
1. Data foundation, the strategy engine (alert-only), intraday templates, and alerts (inbox and channel).
2. Long-term templates, fundamentals, the Flex holdings import, and the covered-call templates.
3. IBKR paper trading, the guard, reconciliation, and performance tracking (Paper tab).
4. Ask (chat) with `draft_strategy`, `explain_signal`, and `strategy_performance`.

The hostname move to `trading-hub` happens before slice 1 goes live on `trading.tobytran.dev`.

## 15. What v1 Must Not Block (for v2 and v3)

- The broker interface takes a mode (`paper` now; `live` later). Live mode needs its own guard and an extra confirmation step.
- The stage machine can grow to add `live_confirm` and `live_auto`.
- Family-wide caps and the off switch already apply to every order path.
- Every order is traceable to a strategy version and a signal.

## 16. Mockups (Paper)

All mockups are in the file "TobyTest", page "Family Desk · R2 mockups". Dark instrument-panel style: Inter, amber `#FFB020` as the single accent for live/alert/paper state, and green/red only for price direction.

| Artboard | Shows |
|---|---|
| D1 · Today (desktop) | Watchlist, chart with the paper position (entry, stop, target), strategy signal feed, "Desk read" |
| D2 · Strategies (desktop) | Strategy list with owner, stage, and 30-day paper P&L; builder blocks; stage control with Live locked; unsaved-change bar |
| D3 · Paper (desktop) | Paper P&L, open positions by strategy, per-strategy table, fill journal, "Pause all strategies", Backtests locked as "later" |
| M3 · Today (mobile) | Signal feed: paper fill, VWAP alert, short-call risk with a roll idea, persona review |
| M2 · ES chart (mobile) | Futures strategy armed at the overnight high |
| M5 · Watchlist (mobile) | Lists as strategy inputs, rows tagged with signals |
