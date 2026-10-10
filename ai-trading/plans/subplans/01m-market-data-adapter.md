# Market Data Adapter for ai-hedge-fund (Alpaca + SEC EDGAR): Design

**Date:** 2026-10-10 · **Lane:** open-source (Trading Hub) · **Status:** draft for owner review

Related: [01k](01k-ai-hedge-fund-data-options.md) (options; this design replaces its "wait for the Desk" ordering), Desk [02a §7](02a-desk-v1-strategies-design.md) and [02b](02b-desk-market-data-options.md) (the Desk's own data plans), [STATUS.md](../STATUS.md).

## 1. Goal

- ai-hedge-fund runs real backtests and paper ticks without a Financial Datasets subscription, at $0.
- The data source sits behind a wrapper with one provider per data kind, so a provider can be swapped later (IBKR prices, the owner's broker) without touching ai-hedge-fund or the other providers.
- Success: the five persona strategies (Buffett, Munger, Graham, Lynch, Druckenmiller) backtest on US stocks from our data; anything we cannot supply fails loudly with a clear message, never as empty data.

## 2. Owner Decisions (2026-10-10)

- Build the adapter now; do not wait for the Desk data layer.
- v1 sources: Alpaca for prices, SEC EDGAR for fundamentals and company facts. IBKR comes later.
- The post-earnings-drift strategy (PEAD) needs consensus EPS estimates, which no free source has with history. It is unsupported in v1 and fails with a clear error.

## 3. What ai-hedge-fund Needs (pinned `78b779c`, v2.5.0)

All data goes through `hedge_fund.data.FDClient`, which calls the Financial Datasets HTTP API at the class attribute `FDClient.BASE_URL` with an `X-API-Key` header. The TUI refuses to start without `FINANCIAL_DATASETS_API_KEY`.

| Endpoint | Used by | v1 source |
|---|---|---|
| `GET /prices/` (`interval=day` only) | backtests, benchmark sessions, snapshots | Alpaca daily bars |
| `GET /financial-metrics/` (`filing_date_lte`, `period=ttm`, `limit`) | persona snapshots (`features/snapshot.py`), TUI | Computed from SEC XBRL plus Alpaca closes |
| `GET /company/facts/` | snapshots (sector, industry), TUI | SEC submissions |
| `GET /earnings/` | PEAD, event study | **Unsupported** (HTTP 501) |
| `GET /news/`, `GET /insider-trades/` | nothing in v2 code paths | **Unsupported** (HTTP 501) |

Upstream reads 12 metric fields: `market_cap`, `price_to_earnings_ratio`, `return_on_equity`, `gross_margin`, `operating_margin`, `net_margin`, `debt_to_equity`, `current_ratio`, `revenue_growth`, `earnings_per_share`, `book_value_per_share`, `free_cash_flow_per_share`. Every other `FinancialMetrics` field is nullable and stays null.

`FDClient` treats 404 as "no data exists" and raises on every other error status. So unsupported endpoints and provider failures return 501 or 502 with a message, never 404 and never an empty list.

## 4. Approaches

1. **FD-shaped HTTP service (recommended).** A small `market-data` container answers the Financial Datasets API shape. The ai-hedge-fund wrapper image points `FDClient.BASE_URL` at it. It is coupled only to the vendor's public HTTP API, which stayed stable while upstream rewrote its client (`src/tools/api.py` became `hedge_fund/data/client.py`). Other apps or the Desk can reuse it later.
2. **In-process client.** Inject a Python `DataClient` by patching `FDClient` inside the ai-hedge-fund process. No new container, but it binds to upstream's internal module and import names (`run.py` and `tui/app.py` import `FDClient` by name), so every weekly bump can break it.
3. **Wait for the Desk's `/api/data`.** Rejected by the owner.

## 5. Design (Approach 1)

### 5.1 Service

- Code in `ai-trading/market-data/` (our code, not upstream). Python 3.11 standard library only: `http.server.ThreadingHTTPServer` and `urllib`. No new dependencies.
- Image `ai-trading-market-data`, compose service `market-data` on the `ahf` network only. No tunnel ingress, no Caddy route, no published port.
- Requests must carry `X-API-Key` equal to `MARKET_DATA_TOKEN` (constant-time compare). Otherwise 401.
- Responses use the vendor's shapes: `{"prices": [...]}`, `{"financial_metrics": [...]}`, `{"company_facts": {...}}`. Never a `next_page_url`.
- `GET /healthz` for the compose healthcheck.

### 5.2 Provider seam

```python
class PriceProvider(Protocol):
    def daily_bars(self, ticker: str, start: str, end: str, adjustment: str) -> list[Bar]: ...

class FundamentalsProvider(Protocol):
    def facts(self, ticker: str) -> CompanyFacts | None: ...
    def filings(self, ticker: str) -> list[FilingFacts]: ...   # XBRL values with filed dates
```

- `PRICE_PROVIDER=alpaca` and `FUNDAMENTALS_PROVIDER=sec` pick the implementations at startup. An unknown name stops the service at startup.
- Metrics are computed in one provider-independent module from `filings()` plus `daily_bars()`, so an IBKR price provider later changes one environment value and one new class.

### 5.3 Alpaca prices

- `GET https://data.alpaca.markets/v2/stocks/{ticker}/bars`, `timeframe=1Day`, `feed=sip`. The free plan allows SIP history when the end is at least 15 minutes old; requests only ever ask for completed sessions.
- `/prices/` returns split-adjusted bars (`adjustment=split`). Market cap uses raw closes (`adjustment=raw`), because SEC share counts are as reported.
- Only `interval=day` with `interval_multiplier=1`. Anything else returns 501.
- Alpaca pagination (`next_page_token`) is followed inside the service. 429 retries with a short backoff, then 502. The free limit is 200 requests a minute.

### 5.4 SEC EDGAR fundamentals

- Ticker to CIK from `https://www.sec.gov/files/company_tickers.json`. Facts from `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json`, company metadata from `.../submissions/CIK##########.json`.
- Every request sends `SEC_USER_AGENT` (a name and contact address, kept in Firestore because the repo is public). Rate limit 10 requests a second. Responses are cached in memory for 24 hours.
- **Point-in-time:** each value keeps its `filed` date. A `/financial-metrics/` row for a fiscal period appears only if its filing was filed on or before `filing_date_lte`. `filing_date` is that filing date. Restated values filed later never leak backward.
- **TTM:** income and cash-flow concepts sum the latest four quarters. Q4 is derived as the fiscal-year value minus Q1 to Q3 when no Q4 fact exists. Balance-sheet concepts use the period-end value.
- **Concepts** (us-gaap, with listed fallbacks): revenue (`Revenues`, `RevenueFromContractWithCustomerExcludingAssessedTax`, `SalesRevenueNet`), `GrossProfit` (or revenue minus `CostOfRevenue`), `OperatingIncomeLoss`, `NetIncomeLoss`, `StockholdersEquity`, `AssetsCurrent`, `LiabilitiesCurrent`, debt (`LongTermDebt` plus `DebtCurrent`, or `LongTermDebtNoncurrent` plus `LongTermDebtCurrent`), `NetCashProvidedByUsedInOperatingActivities`, `PaymentsToAcquirePropertyPlantAndEquipment`, diluted EPS (`EarningsPerShareDiluted`), and shares (`dei:EntityCommonStockSharesOutstanding`, else `WeightedAverageNumberOfDilutedSharesOutstanding`).
- **Ratios:** margins over TTM revenue; ROE = TTM net income / equity; debt/equity; current ratio; revenue growth = TTM revenue versus the TTM four quarters earlier; EPS = sum of four quarters of diluted EPS; book value and free cash flow per share use the share count; market cap = shares times the raw close on the filing date (or the prior session); P/E = market cap / TTM net income (null when income is not positive).
- A missing concept leaves its ratio null, which is what upstream expects. A company with no usable filings returns an empty list: that really means no data. A failure to reach SEC returns 502.
- **Company facts:** name, CIK, `sic_code`, `sic_industry` (the SIC description), `sic_sector` and `sector` (the SIC division name), `industry` (the SIC description), `exchange`, `is_active`. Mapping SIC to GICS sectors is out of scope.
- `period=annual` and `period=quarterly` use the same rules without TTM summing. `period=ttm` is what upstream uses.

### 5.5 Wiring ai-hedge-fund without editing upstream

- The wrapper image (`deploy/upstream/ai-hedge-fund/Dockerfile`) adds a `sitecustomize.py` to the venv. When `FD_BASE_URL` is set, it sets `hedge_fund.data.client.FDClient.BASE_URL` to it before any app code runs, so every `FDClient()` in the TUI and `run.py` uses the service.
- Compose sets `FD_BASE_URL=http://market-data:8000` on `ahf-terminal` (not secret).
- Firestore: a new profile `ai-trading/market-data` (`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `SEC_USER_AGENT`, `MARKET_DATA_TOKEN`). `ai-trading/ai-hedge-fund`'s `FINANCIAL_DATASETS_API_KEY` is linked to `ai-trading/market-data:MARKET_DATA_TOKEN`, which also satisfies the TUI's key prompt.
- `deploy.sh` renders the new profile like the other four. `SECRET_FILES` gains `market-data.env`, with its Firestore-render, rollback, and test cases.
- **Owner gate:** create a free Alpaca account and API key pair, and choose the SEC contact string. Both go into Firestore through `family_config.py set`. The image ships before that; without the profile the service starts, answers 502 "Alpaca not configured", and the other apps are unaffected.

### 5.6 Out of scope for v1

- Earnings and PEAD, news, insider trades, intraday bars, non-US listings, GICS sectors.
- IBKR prices: a later `IbkrPriceProvider` through the Desk's IB Gateway (Desk Phase 3), chosen with `PRICE_PROVIDER=ibkr`. Coordinate with the Desk lane at that point; the Desk may adopt or replace this service.

## 6. Verification

Offline (CI `scripts` job, `python -m unittest`):
- Metric computation from small public SEC fixtures: TTM summing, derived Q4, the point-in-time cut (a restated value filed later stays hidden), and null ratios for missing concepts.
- HTTP contract: run upstream's real `FDClient` (installed in the test image) against the service with fake providers; prices, metrics, and facts parse into upstream's models; `/earnings/` raises `FDClientError` with status 501; a bad key gets 401.
- Alpaca pagination and 429 handling against a fake server.
- Image smoke: inside `ahf-terminal`, `FDClient.BASE_URL` equals `FD_BASE_URL`.

Live, after deploy (sponsored LLM keys allowed):
- From `ahf-terminal`: prices, metrics, and facts for AAPL and MSFT. Spot-check one quarter's revenue and EPS against the 10-Q.
- Build a `FundamentalsSnapshot` for AAPL as of a past date, with no LLM call.
- One short persona backtest from the TUI with a real model call.
- The PEAD strategy shows the "earnings data unsupported" error.
