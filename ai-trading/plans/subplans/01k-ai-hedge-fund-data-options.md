# ai-hedge-fund Without a Financial Datasets Key: Options

Status: proposal for owner review (researched 2026-10-09, reconciled with the Desk plan 2026-10-10). Nothing is implemented. No sign-up, subscription, or live data call is authorized.

Related: the Desk lane's `02a-desk-v1-strategies-design.md` §7 and `02b-desk-market-data-options.md` (the Desk's data layer; they land with the Desk design), [STATUS.md](../STATUS.md).

## 1. Goal and Scope

- ai-hedge-fund runs without a Financial Datasets API key. Free or budget sources only.
- First scope: US stocks and ETFs, completed daily sessions, research and paper backtests. Not live execution, options, futures, or global fundamentals.
- The paid-data cap is $30 per month for the whole ai-trading stack. The Desk's IBKR data expects $4.50–$14.50 of it (`02b` §4), so any paid provider here must fit the remaining $15.50–$25.50.
- Upstream sources stay untouched. A change goes in the wrapper image (`deploy/upstream/ai-hedge-fund/`).

## 2. What the Code Needs

- `hedge_fund/data/protocol.py` defines `DataClient`: prices, point-in-time financial metrics, news, insider trades, company facts, earnings, earnings history, market cap. Its Yahoo client is only an example.
- Empty or `None` means genuinely missing data. Auth, network, and rate-limit failures must raise. Metrics must have been publicly filed by the requested as-of date, not just have an earlier fiscal period end.
- The TUI's `_demand_run_keys` hard-codes the Financial Datasets key prompt, and the TUI and `run.py` build `FDClient` directly in several places. `FDClient.BASE_URL` is hard-coded and there is no provider-selection setting. A different key alone cannot switch providers.
- Core investor snapshots need prices, company facts, and financial metrics (20 quarter-spaced TTM rows requested, at least 4 required). PEAD and event studies also need earnings history and accurate filing times. News and insider methods have no current core caller.

## 3. Options

| | Option | Cost | Fit |
|---|---|---|---|
| A | **Use the Desk's `/api/data`** by pointing `FDClient.BASE_URL` at it from the wrapper image (the plan in 02a §7: "later, not v1") | $0 beyond the Desk's own sources | Recommended. One data layer for both apps: Alpaca free history since 2016, SEC EDGAR XBRL fundamentals, Finnhub, FRED. No second adapter. Needs the Desk's `/api/data/*` to answer Financial Datasets-shaped requests (prices, financial metrics, company facts) and a family-issued token in `FINANCIAL_DATASETS_API_KEY`, which also satisfies the TUI key prompt. |
| B | **Standalone provider:** a small adapter over Alpaca Basic plus SEC EDGAR, bound in by a wrapper launcher | $0 | Only if ai-hedge-fund must work before the Desk's data layer exists. It duplicates A's sources. Alpaca: daily bars since 2016, 200 requests per minute, SIP history when the end is at least 15 minutes old, free account and keys required. SEC `companyfacts` and `submissions` need no key but are not a ready-made metrics API: filings, quarters, TTM, and earnings actuals must be normalized with filing timestamps. |
| C | Yahoo/yfinance plus SEC | $0 | Exploratory fallback only: unofficial API, personal-research terms, rate limits, no SLA, short statement history, weak point-in-time fundamentals. |
| D | FMP | Free 250 calls a day; Starter $29 monthly ($19 billed yearly); Premium $69 ($49 yearly) | Starter's fundamentals are annual and about 5 years, so it likely lacks the quarterly and TTM history. Its terms require an agreement for display and redistribution; confirm private two-user use first. Starter alone exceeds the headroom. |
| E | EODHD | $19.99 EOD prices only; $59.99 fundamentals (no prices); $99.99 all-in-one | Prices-only fits the headroom but has no fundamentals. Global coverage is better than this scope needs. |

## 4. Recommendation

Take A. Build B only if the Desk's data layer slips and the owner wants ai-hedge-fund earlier. Do not pay for D or E.

Whichever option is chosen:
- The wrapper (not upstream) selects the provider and sets `FDClient.BASE_URL` or the client binding before the app starts, the same pattern as Vibe-Trading's `start-vibe.py`. Confirm in a spike that a class attribute can be set before the TUI and `run.py` build their clients.
- Unsupported endpoints raise a visible error, never an empty result. A strategy needing an unsupported field is blocked with a clear message.
- Provider keys and the SEC contact User-Agent live only in Firestore profiles.

## 5. Next Steps (After Approval)

1. Choose A or B, and confirm the first scope.
2. Spike: prove prices, quarterly filings and TTM, and the required strategy fields for a handful of public tickers, with no paid model calls and no calls to Financial Datasets.
3. Offline contract checks: pagination, splits and dividends, time zones, as-of filing dates and revisions, 429 and auth failures, insufficient coverage. A synthetic backtest must make zero calls to Financial Datasets.
4. Only then, an operator-approved live read-only comparison.

## 6. References

- Alpaca: https://docs.alpaca.markets/us/docs/about-market-data-api and https://docs.alpaca.markets/us/docs/market-data-faq
- SEC: https://www.sec.gov/search-filings/edgar-application-programming-interfaces
- FMP: https://site.financialmodelingprep.com/pricing-plans
- EODHD: https://eodhd.com/pricing
- yfinance: https://github.com/ranaroussi/yfinance
