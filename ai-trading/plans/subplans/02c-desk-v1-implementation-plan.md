# Family Desk v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This file is the master plan. Each phase has its own task file under [02c-desk-v1-tasks/](02c-desk-v1-tasks/), written with the writing-plans skill and reviewed by the owner before that phase starts. This keeps every task file small enough to carry complete code. Phase 0 is written in full now.

**Goal:** Ship Family Desk v1 at `trading.tobytran.dev`. User-owned, versioned strategies alert automatically and paper-trade on IBKR paper. They run on one shared IBKR live feed plus a free history store. Delivery is in phases, and each phase ships working, tested software.

**Architecture:**
- One Python 3.12 backend image runs two services:
  - `api` (FastAPI): REST, SSE, AG-UI chat, the live stream, and `bar_close_1m` strategy evaluation.
  - `scheduler`: backfills, daily and weekly strategies, imports, and watchdog checks.
- Strategy specs are JSON, validated by Zod v4 schemas in `ai-trading/contracts`. Those schemas generate JSON Schema, which generates the backend's Pydantic models.
- Pure functions in `ai_trading.core` evaluate specs on closed bars stored in PostgreSQL 17.
- One IB Gateway (IBC) serves live data and paper orders, unless the Phase 0 spike forces the two-gateway fallback.
- The static Next.js Desk is served from GCS through the existing Worker pattern. `/api/*` reaches `api` through the tunnel and the Clerk/Caddy gate.

**Tech Stack:**
- Backend: Python 3.12, uv, FastAPI, PydanticAI (`pydantic-ai-slim[ag-ui]`), `ib_async` 2.1, `alpaca-py`, `exchange_calendars`, SQLAlchemy 2 + Alembic, pytest, ruff
- Database: PostgreSQL 17
- Contracts and web: Node 24, pnpm 11.9.0, Zod v4, Next.js 16 static export, Tailwind CSS 4, TradingView lightweight-charts, assistant-ui
- Infrastructure: Docker Compose, `ghcr.io/gnzsnz/ib-gateway` (IBC), Cloudflare Worker and Tunnel (Terraform), Firestore `family-config`

**Spec:**
- [02a-desk-v1-strategies-design.md](02a-desk-v1-strategies-design.md) (primary)
- [02b-desk-market-data-options.md](02b-desk-market-data-options.md) (data sources and cost)
- [02-release-2-desk-design.md](02-release-2-desk-design.md) (base design wherever 02a is silent)
- Mockups: Paper file "TobyTest", page "Family Desk · R2 mockups"

## Global Constraints

- **Paid market data:** at most $30 per month for both users combined (02b §1).
- **Hostnames (02a §8):**
  - `trading.tobytran.dev` is the Family Desk.
  - `trading-hub.tobytran.dev` is the hub, replacing `trading-static`.
  - `vibe-trading.` and `mirofish.` are unchanged.
- **Paper-only guard (02a §6, §3):** refuse any order unless the connected account ID starts with `DU`, the gateway is on the paper port, and the Desk config is `paper`. v1 contains no live order code.
- **Strategy specs (02a §4.3):**
  - JSON with a required `schemaVersion`.
  - Zod v4 in `ai-trading/contracts` is the source of truth; it generates JSON Schema and then Pydantic.
  - CI fails on drift.
  - The API re-validates every save.
- **Versions (02a §4.1):** every save creates an immutable strategy version. Signals, alerts, order intents, and fills stay attributed to the version that produced them.
- **Evaluation (02a §5):** rules evaluate on closed bars only. The signal dedupe key is (strategy version, symbol, bar time).
- **Data-quality labels (02a §5):** `realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable`.
- **Stages (02a §4.2):** `draft` → `alert_only` → `paper`. v1 code must not offer `live_confirm` or `live_auto`.
- **Time (02 §4.3):** schedules use America/New_York on exchange trading days. Timestamps are stored in UTC.
- **Streaming slots (02a §7):** the Desk uses at most 70 of IBKR's default 100.
- **Family-wide limits (02a §4.4):** at most 12 paper orders per day, plus a global off switch.
- **LLM budgets (02 §6.6):** 12 model requests and 60,000 tokens per chat run; $25 per user per calendar month.
- **Secrets (AGENTS.md, 02a §10):**
  - Firestore profile `ai-trading/desk`, read and written only through `common/config/family_config.py`.
  - No `.env` files inside `ai-trading/`.
  - Never print values.
- **Public repository (02a §10):** no balances, positions, account numbers, emails, or VPS addresses in commits. Mockups and fixtures use made-up numbers.
- **Upstream code:** never edit `ai-trading/packages/*` (upstream submodules).
- **Git (AGENTS.md):**
  - The main session works in the main checkout on `feature/toby`, fast-forwarded onto `origin/dev` before new work.
  - Subagents work in `.worktrees/` worktrees, and the main session merges their branches.
  - Single-line commit messages without trailers.
  - Pull requests to `dev`.

## Review Focus

1. **Stale or delayed data must never place a paper order.**
   - A strategy is "degraded" when the gateway is down, it has no streaming slot, or an input is `fallback`.
   - A degraded strategy may alert (labeled) but creates no order intent.
   - Pinned by tests in Phase 3 (degraded alert) and Phase 6 (order gate).
2. **No repainting.**
   - A rule that is true mid-bar but false at the close must not fire.
   - A restart must not re-emit a signal for a bar that was already evaluated.
   - Pinned by tests in Phase 1 (evaluator) and Phase 3 (dedupe across restarts).
3. **Session-calendar edges.** These must all produce the right opening range, pre-market window, `flatBy`, and `premarket_0830` timing:
   - daylight-saving changes
   - half days (13:00 ET close)
   - exchange holidays
   - the futures Sunday 18:00 ET open
   - Pinned by tests in Phase 1 (session calendar) and Phase 3 (scheduler).
4. **Futures roll.**
   - When the front month changes (for example ES Dec → Mar), indicators and levels must not see a fake gap between contracts.
   - Levels reset per contract, and an open paper position keeps its own contract.
   - Pinned by tests in Phase 2 (roll map) and Phase 6 (position contract).
5. **Editing a strategy that holds a paper position.**
   - The position and its exits stay on the old version until it is flat.
   - The new version only opens new trades.
   - Pinned by tests in Phase 6.

---

## Phases

| Phase | Ships | Depends on | Task file | Status |
|---|---|---|---|---|
| 0. Verification spike | Answers for 02a §12; read-only IBKR and Flex probe tools | none | [phase-0-spike.md](02c-desk-v1-tasks/phase-0-spike.md) | In progress |
| 1. Strategy core | Contracts package, backend scaffold, session calendar, indicators, levels, evaluator, intraday and swing templates (no I/O) | none; can run beside Phase 0 | `phase-1-strategy-core.md` | Next |
| 2. Data foundation | Postgres schema, bar store and backfills, IBKR live adapter, futures roll, streaming slots, calendar/news/fundamentals adapters | 0, 1 | `phase-2-data.md` | Planned |
| 3. Runtime and alerts | `api` and `scheduler`, live evaluation, alert outbox, Telegram/Slack, watchdog checks, compose services, Firestore profile, backups (deployed) | 2 | `phase-3-runtime.md` | Planned |
| 4. Desk web and hostnames | Desk static app (Today, Strategies, Watchlists, Settings); `trading.tobytran.dev` points at the Desk after the open-source lane moves the hub to `trading-hub` | 3, plus the hub move (open-source lane) | `phase-4-web.md` | Planned |
| 5. Long-term | Fundamentals and persona-review blocks, covered-call and short-call templates, Flex and CSV import, Holdings page | 3 (UI after 4) | `phase-5-long-term.md` | Planned |
| 6. Paper trading | Paper broker with guard, bracket orders, reconciliation, flat-by, limits, off switch, stats, Paper tab | 3 (UI after 4) | `phase-6-paper.md` | Planned |
| 7. Ask | PydanticAI agent over AG-UI with market, strategy, and drafting tools; budgets | 5, 6 | `phase-7-ask.md` | Planned |

**Delivery:** AGENTS.md's standing delivery authorization applies to each phase:
1. verify and review;
2. merge the pull request to `dev`;
3. release the phase's ai-trading paths to `main`;
4. deploy and verify the live result.

Phases 0–2 change nothing that is deployed. Phases 3–7 deploy.

## Execution Map

| Wave | Who | What |
|---|---|---|
| A | Main session + owner | Phase 0. The owner sets up IBKR (Task 0.4); the main session runs the probes and records results. |
| B | One subagent in a worktree, after the owner reviews `phase-1-strategy-core.md` | Phase 1. It needs no IBKR access, so it runs while Wave A waits on the owner. |
| C | Main session with subagents per task file | Phases 2 → 3 → 4, then 5 and 6 (UI tasks after 4), then 7 |

## Shared Interfaces

These names are fixed for every phase. A task file may add names but must not rename these.

| Thing | Name |
|---|---|
| Contracts package | `ai-trading/contracts`, pnpm name `@ai-trading/contracts`, schema export `StrategySpecV1Schema` |
| Generated JSON Schema | `ai-trading/contracts/generated/strategy-spec-v1.schema.json` |
| Shared spec fixtures | `ai-trading/contracts/fixtures/strategy-spec-v1/{valid,invalid}/*.json` (both test suites read them) |
| Backend project | `ai-trading/backend`, uv project `ai-trading-desk`, import package `ai_trading` under `src/` |
| Generated Pydantic models | `ai_trading.contracts.strategy_spec_v1` (generated; never hand-edited) |
| Backend modules | `ai_trading.core` (pure), `ai_trading.data`, `ai_trading.db`, `ai_trading.engine`, `ai_trading.notify`, `ai_trading.broker`, `ai_trading.agent`, `ai_trading.api`, `ai_trading.jobs` |
| Services | `api` (port 8000), `scheduler`, `ib-gateway` (paper API 4004 via the image's socat), `desk-postgres` (5432); all internal, no host ports |
| Firestore profile | `ai-trading/desk`, key names: see "Firestore keys" below |
| Data-quality labels | `realtime`, `delayed-15m`, `eod`, `fallback`, `unavailable` |
| Stages | `draft`, `alert_only`, `paper` |
| Cadences | `bar_close_1m`, `premarket_0830`, `daily_close`, `weekly` |
| Tables | 02 §7 plus 02a §9 |
| Probe tools | `ai-trading/tools/ibkr-probe/` (Phase 0), kept as the manual gateway smoke test |

Firestore keys in `ai-trading/desk` (names only; values only through `family_config.py`):
- **IBKR:** `IBKR_PAPER_USERNAME`, `IBKR_PAPER_PASSWORD`. If the two-gateway fallback applies, also `IBKR_DATA_USERNAME` and `IBKR_DATA_PASSWORD`.
- **Flex import:** `IBKR_FLEX_TOKEN` and `IBKR_FLEX_QUERY_ID`, one pair per imported account. Phase 5 names the per-account suffixes.
- **Data sources:** `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`.
- **Alert channels:** `TELEGRAM_BOT_TOKEN`, `SLACK_WEBHOOK_URL_OWNER`, `SLACK_WEBHOOK_URL_SPOUSE`.
- **Database:** `DESK_DB_PASSWORD`.
- **LLM keys:** linked from `shared/llm`.

---

## Phase Outlines

Each phase's task file turns its outline into complete, test-first tasks.

### Phase 1: Strategy core (no I/O)

- **`ai-trading/contracts`:**
  - `src/strategy-spec-v1.ts`: the Zod v4 schema for 02a §4.3–4.4. Covers watch, when (`all`/`any`/`not` and the operators), then (alert, paperOrder), limits, and `schemaVersion: 1`.
  - `scripts/generate-json-schema.ts` and `scripts/check-generated.mjs`, mirroring `expense-tax-management/packages/contracts`.
  - vitest over the shared fixtures.
- **`ai-trading/backend`:**
  - uv project with ruff and pytest.
  - `scripts/generate-contracts.sh` runs `datamodel-code-generator` from the JSON Schema.
  - A pytest suite checks that the Pydantic models accept and reject exactly the same fixtures as Zod.
- **`ai_trading.core`:**
  - `calendar.py`: XNYS and CME sessions via `exchange_calendars`, including half days and DST.
  - `indicators.py`: SMA, EMA, RSI, ATR, session VWAP, relative volume.
  - `levels.py`: prior-day high/low/close, pre-market high/low, overnight high/low, opening range, N-day high/low.
  - `evaluate.py`: closed-bar evaluation of a spec into signal candidates with evidence.
  - `templates/`: the intraday and swing templates from 02a §4.5.
- **Acceptance:** golden tests for every template (fires, does not fire, repaint-safe); calendar tests for DST, a half day, and a holiday; a CI job for contracts and backend; `uv run pytest` and `pnpm test` pass.

### Phase 2: Data foundation

- **`ai_trading.db`:** SQLAlchemy models and Alembic migrations for the Shared Interfaces tables, plus `deploy/postgres/` role and schema init.
- **`ai_trading.data`:**
  - Interfaces: `MarketData`, `Calendar`, `News`, `Fundamentals`.
  - Adapters: Alpaca history, Stooq daily fallback, IBKR, Finnhub, FRED, SEC EDGAR, Yahoo fallback. The IBKR adapter covers the live 1-minute bar builder, futures history, daily IV, and option snapshots.
  - The bar store with backfill on watchlist add.
  - The futures roll map.
  - The streaming slot manager (priority order from 02a §7).
  - Internal `/api/data` read models.
- **Acceptance:**
  - adapter contract tests on recorded responses, with no network in CI;
  - store tests against a real Postgres container;
  - the roll test (no cross-contract gap) and the slot-priority test.

### Phase 3: Runtime and alerts (deployed)

- **`ai_trading.api`:**
  - FastAPI with identity from the gateway's verified header.
  - REST for watchlists, strategies, versions, signals, alerts, and settings.
  - SSE quotes, at most about 4 updates per second.
- **`ai_trading.engine`:**
  - Live `bar_close_1m` evaluation, degraded detection, and outbox writes.
  - Scheduler jobs: `premarket_0830`, `daily_close`, `weekly`, the 15-minute refresh, backfills, watchdog checks, and the Sunday 18:00 ET re-login reminder.
- **`ai_trading.notify`:** inbox, Telegram, and Slack webhook adapters, with quiet hours, retries, and secret redaction.
- **Deploy:**
  - compose services `api`, `scheduler`, `ib-gateway`, `desk-postgres`, with memory limits sized to the Phase 0 VPS headroom;
  - the Caddy `/api/*` route on the origin;
  - `deploy.sh` renders `ai-trading/desk`;
  - a backup instance and its restore drill.
- **Acceptance (staging):** an `alert_only` template strategy sends a Telegram alert from live data, and a restart sends no duplicate.

### Phase 4: Desk web and hostnames

- **Desk static app:**
  - Today, Strategies (list, builder, versions, JSON view), Watchlists, and Settings (channels, quiet hours, off switch).
  - The PAPER badge and data-quality labels on every number.
  - Charts with lightweight-charts.
  - Built from the Paper mockups.
- **Infrastructure:**
  - The open-source lane moves the hub to `trading-hub` (AGENTS.md "Hostnames"). Phase 4 waits for that move and its staging checks; it does not redo them.
  - Phase 4 then adds a GCS bucket and Worker routes for `trading.tobytran.dev` (static plus `/api/*`) and points `trading.tobytran.dev` at the Desk.
- **Acceptance:**
  - a Playwright smoke test: Today → Strategies → create from template → save a version → its alert appears;
  - the 01h Task 10 staging checks repeated on `trading-hub`.

### Phase 5: Long-term

- **Blocks:** fundamentals (SEC EDGAR) and `persona_review` (structured `{signal, confidence, reasoning}` output, within the LLM budget).
- **Templates:** covered-call and short-call, using 02 §6.3 math adapted from Vibe-Trading `quantlib/options.py` with attribution.
- **Imports and UI:** IBKR Flex import (Open Positions plus Open Lots), CSV import, and the Holdings page.
- **Acceptance:** golden tests on fixture option chains; Flex import from a fixture statement; budget refusal.

### Phase 6: Paper trading

- **`ai_trading.broker`:**
  - the paper guard;
  - limit, stop, and bracket orders through `ib_async`;
  - the order-intent outbox, with `orderRef` set to the order intent ID;
  - fills;
  - reconciliation on reconnect and every 15 minutes;
  - flat-by, per-strategy limits and pause, and the global off switch.
- **Results:** the `strategy_stats` rollup and the Paper tab.
- **Acceptance:**
  - the guard refuses non-`DU` accounts, a non-paper port, and a non-paper config;
  - on staging, a `paper` template places a bracket order and its fill is attributed to the right version;
  - Review Focus 5 is pinned.

### Phase 7: Ask

- **Agent:** PydanticAI over AG-UI at `/api/agent`.
- **Tools:** 02 §6.4's tools plus `draft_strategy`, `explain_signal`, `strategy_performance`, `fundamentals`, `futures_info`, `swing_setups`.
- **Budgets and UI:** usage limits and budgets; the assistant-ui page.
- **Acceptance:**
  - test-model tool wiring;
  - `draft_strategy` output always passes the schema and is never saved without confirmation;
  - budget refusal.
