# Phase 0: Upstream Package Evaluation

Status: Done (2026-10-04)

Method: read-only static review of each checkout by three parallel reviewers. No dependencies were installed and no code was executed. Raw per-repo notes are in `ai-trading/temp/eval/*.md` (local only, gitignored).

## Checkouts

| Package | Path | Upstream commit | License | Activity (last 90 days) |
|---|---|---|---|---|
| TradingAgents | `packages/trading-agents` | `1394a3f` (2026-10-03) | Apache-2.0 | 231 commits, 6 authors |
| ai-hedge-fund | `packages/ai-hedge-fund` | `78b779c` (2026-10-02) | MIT | 78 commits, 4 authors (73 by one maintainer) |
| Vibe-Trading | `packages/vibe-trading` | `251b094` (2026-10-04) | MIT + `NOTICE` | 2,302 commits, 139 authors |

Sync a checkout: `git -C ai-trading/packages/<name> pull`.

## What each repo is

### TradingAgents

A LangGraph pipeline that produces one Buy/Hold/Sell decision per ticker and date: four analysts (market, news, sentiment, fundamentals), a bull/bear research debate, a trader, a three-way risk debate, and a portfolio manager. It ships as a Python library, a Typer CLI, and a static HTML report. Data is daily bars only, from Yahoo Finance, Alpha Vantage, SEC EDGAR, FRED, Polymarket, Reddit, and StockTwits. Tests and CI are mature.

Verdict: use as a library for narrow layers; reference only for the agent graph.

Borrow:

- `tradingagents/llm_clients/`: provider factory (OpenAI, Anthropic, Google, Bedrock, Azure) plus an OpenAI-compatible registry that reaches DeepSeek and vLLM endpoints without code changes.
- `tradingagents/dataflows/router.py`, `dataflows/errors.py`, `dataflows/vendors/`: typed multi-vendor data router with fallback.
- `tradingagents/memory/` (`log.py`, `settlement.py`, `reflection.py`): log a decision, settle its outcome, reflect. Fits a trade journal or an alert-outcome feedback loop.
- The whole graph through `TradingAgentsGraph.propagate()`: candidate for an on-demand "investment committee" report on one ticker.

Risks: daily data only; no options, screener, broker, alerts, auth, or web UI; the graph is a fixed debate narrative and does not reshape into a scanner.

### ai-hedge-fund

Release 2.0.0 (commit `a7a99e5`, 2026-08-02) deleted the FastAPI + React web app (`app/`) and the 13-persona LangGraph pipeline (`src/`): 345 files, about 56k lines. The new `hedge_fund/` package is a persistent simulated fund with one `advance` verb. It runs as a backtest (in-memory SimBroker) or as an internal paper book (JSON ledger), driven from a Textual TUI or a CLI. The last commit with the old web app and all 13 personas is `6c41ae8` (2026-07-31).

Verdict: borrow patterns.

Borrow:

- `hedge_fund/signals/lynch.py`, `buffett.py`, `graham.py` (also Munger and Druckenmiller) and the `LLMAgent` base: GARP and value persona prompts over point-in-time fundamentals. The other 8 personas (Wood, Burry, Ackman, Damodaran, Fisher, Pabrai, Taleb, Jhunjhunwala) exist only at `6c41ae8:src/agents/`.
- `hedge_fund/risk/limits.py`, `hedge_fund/portfolio/construction.py`: deterministic position sizing and risk clamps.
- `hedge_fund/data/protocol.py`, `hedge_fund/data/cached.py`: data-client protocol with a point-in-time cache.

Risks: single maintainer, no CI, a fresh 56k-line rewrite; no TA, intraday data, options, futures, real broker, or web UI; unlisted model ids (for example a self-hosted DeepSeek) silently fall back to the Anthropic provider (upstream issue #711).

### Vibe-Trading

A natural-language finance research agent: LangChain/LangGraph agent loop, 139 prompt skills, multi-agent "swarm" workflows, FastAPI + MCP server (76 tools) + CLI + React/Vite UI, 20+ chat channels, sandboxed backtests of LLM-written strategy code, and 15 broker connectors. Data loaders and factor libraries lean heavily toward China A-share and Hong Kong markets. About 35 MB of the 91 MB checkout is demo media.

Verdict: borrow patterns and copy a few modules. Do not track the whole repo; upstream churn is too high.

Borrow:

- `agent/src/trading/connectors/ibkr/local.py`: local TWS / IB Gateway connector. Paper ports by default (7497, 4002), `readonly=True`, no order methods.
- `agent/src/quantlib/options.py` (Black-Scholes, greeks, implied-volatility solver) and `agent/src/tools/options_chain_tool.py` (Yahoo option chains): base for covered-call math.
- `agent/backtest/runner.py` and `agent/src/core/runner.py`: sandbox for LLM-written strategy code (AST denylist, resource limits, privilege drop, hardened container). Its own comment says an AST denylist cannot be complete.
- `agent/src/channels/`: Telegram, Discord, Slack, and email alert channels.
- `agent/src/providers/`: environment-driven provider and base URL config that already reaches vLLM and SGLang.
- TA skills (`technical-basic`, `ichimoku`, `candlestick`): prompt material for TA Q&A.

Risks: no gap, relative-volume, VWAP, or breakout screener; China-market scrapers (Eastmoney, AKShare) are dead weight; one shared API key and no user accounts. The IBKR cloud-MCP path (`ibkr/mcp.py`) maps only account and positions, but the scope of its OAuth grant is unverified. Use the local read-only connector only.

## Coverage against family needs

| Need | TradingAgents | ai-hedge-fund | Vibe-Trading | We must build |
|---|---|---|---|---|
| TA chat Q&A with charts | Partial (analyst, no chat) | None | Strong | Chat agent on our data tools |
| News, earnings, macro-driven tactics | Strong | Partial (earnings drift) | Partial | Earnings and economic-calendar feed |
| Covered-call Q&A, scanning, alerts | None | None | Partial (chains, greeks) | Scanner, IV rank, holdings, alert rules |
| Preset watchlist scan (gaps, RVOL, VWAP, breakouts) for stocks and futures | None | Partial (daily loop) | Weak | Whole scanner and intraday data |
| Alerts and scheduling | None | Partial (cron tick) | Strong | Scheduler and one channel |
| Backtesting | Partial (scores ratings only) | Partial (no costs) | Strong (costs, futures, sandbox) | Engine choice |
| IBKR paper forward-testing | None | None (internal book) | Read-only connector | Paper order path with a paper-only guard |
| GARP and value research | Partial | Strong (personas) | Partial | Adapt persona prompts |
| Two-user auth | None | None | None (shared key) | Edge auth |
| Web UI, mobile later | None (CLI) | None (TUI) | Strong (React) | Own UI |
| Anthropic and OpenAI now, self-hosted DeepSeek later | Strong | Weak | Strong | Thin provider layer |

## Conclusions

1. None of the three is a usable app base. Each solves a different product: a one-ticker decision debate, a simulated fund, and a broad research agent.
2. The two highest-value jobs, covered-call scanning and the watchlist scanner, exist in none of them. We build both regardless of reuse choices.
3. Syncing whole repos has little value. Recommendation (pending design approval): build our own thin app; copy the small modules listed above with attribution; optionally pin TradingAgents as a library for an on-demand committee report; keep the checkouts as gitignored references and pull occasionally for ideas.
4. License duties when copying code: keep the MIT copyright notice (ai-hedge-fund, Vibe-Trading); keep the Apache-2.0 license text and mark changed files (TradingAgents); honor Vibe-Trading `NOTICE` for anything it lists (Qlib factor definitions, bundled fonts).

## To verify during design

- IBKR paper account: can it use the live account's market-data subscriptions over the API, and what data does it get while the same person is logged in to the live account?
- Unattended IB Gateway login for a paper account (IBC), daily restart, weekly re-authentication.
- Earnings and economic-calendar data source and free-tier limits.
- Yahoo Finance reliability and terms of use as a fallback for option chains.
