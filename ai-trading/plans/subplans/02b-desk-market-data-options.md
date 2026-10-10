# Release 2 Addendum B: Family Desk Market Data Options

Status: Research done 2026-10-10. The owner approved the decision (section 4) the same day. Prices come from vendor and broker pages read on 2026-10-10 and change often. The verification spike in [02a](02a-desk-v1-strategies-design.md) section 12 re-checks the IBKR items before anyone subscribes.

Related: [02a-desk-v1-strategies-design.md](02a-desk-v1-strategies-design.md) (the Desk v1 design that uses this data), [02-release-2-desk-design.md](02-release-2-desk-design.md) section 5 (superseded where it conflicts), [STATUS.md](../STATUS.md).

## 1. Needs

| User | Style | Data need |
|---|---|---|
| Spouse | Day and one-week trades in US stocks/ETFs, index futures (ES, NQ, MES, MNQ), and commodity futures (CL, GC). Limit and stop orders; no high-frequency trading. | Real-time quotes and 1-minute bars including pre- and after-hours. TradingView-style charts inside the Desk. |
| Owner | Long-term, swing, and tactical investing; covered calls | Daily and hourly history; option chains with greeks (a 15-minute delay is fine for scans); fundamentals; earnings and dividend dates |

- Budget: at most **$30 per month** for paid data, both users combined. This replaces the $20 cap in 02.
- The same data layer will later feed the upstream apps (Vibe-Trading, ai-hedge-fund, TradingAgents).

## 2. Findings That Decided It

1. **No vendor sells real-time consolidated US stock data for under $99 per month.**
   - Alpaca Algo Trader Plus costs $99 and Massive Advanced costs $199. Massive is Polygon.io under its new name since 2025-10-30.
   - Cheaper "real-time" feeds cover IEX only, about 2–3% of volume, which biases VWAP and relative volume.
   - Sources: [Alpaca](https://docs.alpaca.markets/docs/about-market-data-api), [Massive](https://massive.com/stocks), [rename](https://massive.com/blog/polygon-is-now-massive).
2. **No vendor sells real-time CME futures for under about $179 per month outside a broker.**
   - Databento Standard costs $179–$199; its blog posts disagree.
   - Massive Futures Starter ($29) is 15 minutes delayed.
   - Sources: [Databento](https://databento.com/pricing), [Massive futures](https://massive.com/futures).
3. **Brokers give account holders real-time data for little or nothing, and both users already hold IBKR accounts.**
4. **Alpaca's free Basic plan serves consolidated (CTA + UTP) historical bars since 2016.**
   - Only the latest 15 minutes are withheld.
   - The limit is 200 calls per minute, and a paper signup is enough.
   - This is the free backbone of the history store. [Alpaca](https://docs.alpaca.markets/docs/about-market-data-api)
5. **IBKR streams snapshots, not every trade.**
   - Updates arrive every 250 ms for US stocks and futures and every 100 ms for US options.
   - True tick-by-tick data is limited to a few symbols at once.
   - [IBKR update frequency](https://www.interactivebrokers.com/docs/tws-api/doc/market-data-live/top-of-book-l-1/market-data-update-frequency)

## 3. Options Considered for Live Data

| Option | Per month | Real-time coverage | Notes |
|---|---|---|---|
| **A. IBKR data login (chosen)** | $4.50–$14.50 | Stocks (all exchanges, extended hours), futures, option greeks; 250 ms | Uses existing accounts, and quotes match the IBKR order ticket. Billed per username; one session per username; $500 minimum equity for subscriptions. Live logins need a weekly 2FA re-login. |
| B. tastytrade free feed | $0 | Stocks, futures, greeks; streamed in batches of about 100 ms (adjustable) | Needs a new funded account per person, possibly with futures approval. Minute history about 43 days. Its tokens refresh without a person. No upstream app supports it. |
| C. Data vendors only | $29 | Stocks IEX-only; futures *or* options 15 minutes delayed | Fails real-time futures |

Ruled out:
- **Tradovate:** $12 for CME Level 1, but a $35/month inactivity fee applies without trades there.
- **Schwab:** needs a new account and a browser re-login every 7 days.
- **Robinhood, Fidelity, Vanguard:** no official market-data API.

IBKR non-professional pricing, per username ([IBKR market data pricing](https://www.interactivebrokers.com/en/pricing/market-data-pricing.php?p=nonpro2)):

| Subscription | Per month | Note |
|---|---|---|
| US Securities Snapshot and Futures Value Bundle | $10 | Waived in months with at least $30 of commissions |
| US Equity and Options Add-On Streaming Bundle | $4.50 | |
| OPRA Level 1 | $1.50 | Only if it is not included in the add-on |
| No subscription | $0 | Free streaming from Cboe One + IEX venues only |

## 4. Decision (Owner, 2026-10-10)

- **Live data:** one dedicated IBKR data username, used by every ai-trading app (the Desk and the upstream apps).
  - Both users share this one subscription.
  - Exchange data is licensed per person, so sharing one non-professional subscription inside the household's own apps is a known gray area. The owner accepted it.
- **History and reference data:** free sources (section 5).
- **Expected paid cost:** $4.50–$14.50 per month, at most half of the cap.

## 5. Hybrid Store: What We Keep and What We Fetch

| Data | Live source | History and backfill | Stored |
|---|---|---|---|
| US stocks and ETFs | IBKR, 250 ms, pre/post market | Alpaca free: daily since 2016, hourly 5 years, 1-minute 30 days. Stooq for daily before 2016, marked `fallback`. | `bars_1d`, `bars_1h`, `bars_1m` (1-minute rolling 90 days) |
| Futures | IBKR, 250 ms | IBKR historical hourly and daily | Same tables, plus a front-month roll map |
| Option chains and greeks | IBKR snapshots at scan or chat time | n/a | Scan results only |
| IV30 for IV rank | IBKR daily | IBKR one-year IV history (to verify in the spike) | `iv_daily` |
| Swing and long-term lists | Alpaca free, 15 minutes delayed, refreshed every 15 minutes | n/a | n/a |
| Fundamentals | n/a | SEC EDGAR XBRL (Finnhub basic financials as fallback), weekly | `fundamentals` |
| Earnings, dividends, news | n/a | Finnhub free + yfinance, at 06:00 and hourly | `calendar_events`, `news_items` (7 days) |
| Macro release dates | n/a | FRED release dates + a static FOMC file | `calendar_events` |

Refresh rules:
- A backfill job runs when a symbol joins a watchlist.
- The day's bars and IV are appended at 16:30 ET.
- A 15-minute in-session refresh covers lists that are not streamed live.

Size:
- At most about 10 million rows: 200 symbols, 20 years daily, 5 years hourly, 90 days of 1-minute.
- Plain PostgreSQL 17 is enough, without a time-series extension.

## 6. Kept on the Bench

| Source | Cost | When we would use it |
|---|---|---|
| Massive Options Starter | $29/month | IBKR option snapshots turn out too slow for scans. It gives 15-minute-delayed full option chains with greeks. |
| marketdata.app Trader | $30 monthly or $12/month billed yearly | Same case, with real-time stock quotes for self-certified non-professionals |
| Databento | $125 free signup credit | One-time deep futures history backfill, if backtesting arrives |
| EODHD | $19.99/month | News with sentiment scores |

## 7. Unverified Items

The [02a](02a-desk-v1-strategies-design.md) spike covers these:
- Whether the $10 waiver applies to a second username on the same account.
- Whether the data username can have a paper login that receives its shared live data.
- IBKR implied-volatility history depth.
- Exact CME non-professional fees, which were inconsistent in CME's January 2026 fee list.
- Finnhub free real-time venue coverage.
- Tiingo intraday history depth.
