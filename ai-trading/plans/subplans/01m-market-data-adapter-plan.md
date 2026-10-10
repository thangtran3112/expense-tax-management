# Market Data Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `market-data` container that answers the Financial Datasets API shape from Alpaca prices and SEC EDGAR fundamentals, wired into ai-hedge-fund without editing upstream.

**Architecture:** Python 3.11 standard-library HTTP service in `ai-trading/market-data/`. One provider class per data kind (`AlpacaPrices`, `SecFundamentals`) behind the two seams the server calls; metrics are computed in one provider-independent module. The ai-hedge-fund wrapper image repoints `FDClient.BASE_URL` with a `sitecustomize.py`.

**Tech Stack:** Python 3.11 stdlib (`http.server`, `urllib`, `unittest`), Docker Compose, `docker buildx bake`, Bash deploy tests.

**Spec:** `ai-trading/plans/subplans/01m-market-data-adapter.md`

## Global Constraints

- Never edit `ai-trading/packages/*`. No new Python dependencies. Never print or commit keys or the SEC contact string.
- Error contract: unsupported endpoint or parameter → HTTP 501; provider unreachable or not configured → 502; bad key → 401; malformed request → 400; **never 404 and never an empty list for a failure** (upstream reads 404 as "no data").
- `/prices/` is split-adjusted; market cap uses raw closes. Only `interval=day`, `interval_multiplier=1`. Only completed sessions: the end date is capped at yesterday (New York).
- Point-in-time: a value counts only if its SEC `filed` date ≤ `filing_date_lte`; the latest such filing wins for a period.
- **Ruling against spec §5.4's last bullet:** `period` other than `ttm` returns 501 in v1. Upstream only ever sends `ttm` (spec §3); annual/quarterly can be added when something asks for them.
- Service port 8000 on the `ahf` network only; no tunnel, Caddy route, or published port.
- One PR to `dev` for the phase, from `feature/toby` (root `AGENTS.md`).

## Review Focus

- A ticker with no XBRL filings (SEC 404) returns `{"financial_metrics": []}`, not 502 (test in Task 3).
- A restatement filed after `filing_date_lte` must not change an earlier row (test in Task 1).
- Alpaca not configured: `/prices/` and `/financial-metrics/` return 502, `/healthz` stays 200 (tests in Tasks 2 and 4).
- A request ending today asks Alpaca only through yesterday (test in Task 4).
- Non-ASCII or empty `X-API-Key` gets 401, never a crash (test in Task 2).

---

### Task 1: Point-in-time TTM metrics

**Files:**
- Create: `ai-trading/market-data/metrics.py`
- Create: `ai-trading/market-data/errors.py` (shared by Tasks 2-4)
- Test: `ai-trading/market-data/test_metrics.py`

**Interfaces:**
- Produces: `ttm_rows(companyfacts: dict, as_of: str, limit: int) -> list[dict]` (newest first; keys `report_period, period, filing_date, currency` plus the ratio fields and private `_shares`, `_net_income_ttm`); `add_valuation(rows, close_lookup)`; `close_lookup(bars) -> Callable[[str], float | None]` (close on or before a day); `public_row(ticker, row) -> dict` (drops `_` keys, adds `ticker`).

- [ ] **Step 1: Write the failing tests** (`test_metrics.py`). The fixture is a made-up company in the SEC `companyfacts` shape.

```python
import unittest

import metrics


def dur(start, end, val, filed, form="10-Q"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form}


def inst(end, val, filed, form="10-Q"):
    return {"end": end, "val": val, "filed": filed, "form": form}


def company(revenue_q4_restated=None):
    rev = [
        dur("2023-01-01", "2023-03-31", 100, "2023-05-01"),
        dur("2023-04-01", "2023-06-30", 110, "2023-08-01"),
        dur("2023-07-01", "2023-09-30", 120, "2023-11-01"),
        dur("2023-01-01", "2023-12-31", 460, "2024-02-15", "10-K"),   # Q4 derived: 130
        dur("2024-01-01", "2024-03-31", 140, "2024-05-01"),
        dur("2023-01-01", "2023-06-30", 210, "2023-08-01"),           # YTD six months: ignored
    ]
    ni = [dur(r["start"], r["end"], r["val"] // 10, r["filed"], r["form"]) for r in rev]
    eps = [dur(r["start"], r["end"], r["val"] / 100, r["filed"], r["form"]) for r in rev]
    if revenue_q4_restated:   # revenue only, so the restated net margin differs
        rev.append(dur("2023-01-01", "2023-12-31", revenue_q4_restated, "2024-06-01", "10-K/A"))
    equity = [inst("2023-12-31", 500, "2024-02-15", "10-K"), inst("2024-03-31", 520, "2024-05-01")]
    return {
        "facts": {
            "us-gaap": {
                "Revenues": {"units": {"USD": rev}},
                "NetIncomeLoss": {"units": {"USD": ni}},
                "EarningsPerShareDiluted": {"units": {"USD/shares": eps}},
                "StockholdersEquity": {"units": {"USD": equity}},
                "AssetsCurrent": {"units": {"USD": [inst("2024-03-31", 300, "2024-05-01")]}},
                "LiabilitiesCurrent": {"units": {"USD": [inst("2024-03-31", 150, "2024-05-01")]}},
            },
            "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [inst("2024-04-20", 10, "2024-05-01")]}}},
        }
    }


class MetricsTest(unittest.TestCase):
    def test_ttm_uses_four_quarters_with_derived_q4(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 10)
        self.assertEqual([r["report_period"] for r in rows], ["2024-03-31", "2023-12-31"])
        latest = rows[0]
        self.assertEqual(latest["filing_date"], "2024-05-01")
        self.assertAlmostEqual(latest["net_margin"], 50 / 500)
        self.assertAlmostEqual(latest["earnings_per_share"], 1.1 + 1.2 + 1.3 + 1.4)
        self.assertAlmostEqual(latest["current_ratio"], 2.0)
        self.assertAlmostEqual(latest["book_value_per_share"], 52.0)
        self.assertIsNone(latest["revenue_growth"])                      # no TTM four quarters earlier

    def test_point_in_time_hides_later_filings(self):
        rows = metrics.ttm_rows(company(), "2024-04-30", 10)
        self.assertEqual([r["report_period"] for r in rows], ["2023-12-31"])
        self.assertEqual(metrics.ttm_rows(company(), "2023-12-31", 10), [])

    def test_restatement_filed_later_does_not_leak_backward(self):
        before = metrics.ttm_rows(company(revenue_q4_restated=480), "2024-05-01", 10)
        after = metrics.ttm_rows(company(revenue_q4_restated=480), "2024-06-01", 10)
        self.assertAlmostEqual(before[1]["net_margin"], 46 / 460)
        self.assertNotEqual(before[1]["net_margin"], after[1]["net_margin"])

    def test_missing_concepts_leave_ratios_null(self):
        row = metrics.ttm_rows(company(), "2024-05-01", 1)[0]
        self.assertIsNone(row["gross_margin"])
        self.assertIsNone(row["debt_to_equity"])
        self.assertIsNone(row["free_cash_flow_per_share"])

    def test_limit_and_valuation(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 1)
        metrics.add_valuation(rows, metrics.close_lookup([{"time": "2024-04-30T04:00:00Z", "close": 20.0}]))
        self.assertEqual(rows[0]["market_cap"], 200.0)                  # 10 shares x close on/before 2024-05-01
        self.assertAlmostEqual(rows[0]["price_to_earnings_ratio"], 200.0 / rows[0]["_net_income_ttm"])
        public = metrics.public_row("AAPL", rows[0])
        self.assertEqual(public["ticker"], "AAPL")
        self.assertFalse([k for k in public if k.startswith("_")])

    def test_non_positive_income_has_no_pe(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 1)
        rows[0]["_net_income_ttm"] = -5
        metrics.add_valuation(rows, lambda day: 20.0)
        self.assertIsNone(rows[0]["price_to_earnings_ratio"])

    def test_quarters_derived_from_year_to_date_cash_flow(self):
        cf = company()
        ocf = [dur("2023-01-01", "2023-03-31", 30, "2023-05-01"), dur("2023-01-01", "2023-06-30", 65, "2023-08-01"),
               dur("2023-01-01", "2023-09-30", 100, "2023-11-01"), dur("2023-01-01", "2023-12-31", 140, "2024-02-15", "10-K"),
               dur("2024-01-01", "2024-03-31", 40, "2024-05-01")]
        capex = [dur(r["start"], r["end"], {30: 10, 65: 20, 100: 30, 140: 40, 40: 10}[r["val"]], r["filed"], r["form"]) for r in ocf]
        cf["facts"]["us-gaap"]["NetCashProvidedByUsedInOperatingActivities"] = {"units": {"USD": ocf}}
        cf["facts"]["us-gaap"]["PaymentsToAcquirePropertyPlantAndEquipment"] = {"units": {"USD": capex}}
        row = metrics.ttm_rows(cf, "2024-05-01", 1)[0]
        self.assertAlmostEqual(row["free_cash_flow_per_share"], ((35 + 35 + 40 + 40) - (10 + 10 + 10 + 10)) / 10)


if __name__ == "__main__":
    unittest.main()
```

Fixture arithmetic, for the reviewer: NI quarters are revenue // 10 → 10, 11, 12, derived Q4 = 46 − 33 = 13, Q1'24 = 14. TTM at 2024-03-31: revenue 110+120+130+140 = 500, NI 11+12+13+14 = 50. TTM at 2023-12-31: revenue 460, NI 46.

- [ ] **Step 2: Run to verify it fails.**

Run: `cd ai-trading/market-data && python3 -m unittest test_metrics -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'metrics'`.

- [ ] **Step 3: Implement.** `errors.py`:

```python
class ProviderError(Exception):
    """A data provider failed or is not configured: HTTP 502, never empty data."""


class Unsupported(Exception):
    """The request asks for data this service does not supply: HTTP 501."""
```

`metrics.py`:

```python
"""Point-in-time TTM metrics from SEC companyfacts (01m §5.4). Provider-independent."""
from bisect import bisect_right
from datetime import date

DURATION = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"],
    "gross_profit": ["GrossProfit"],
    "cost_of_revenue": ["CostOfRevenue", "CostOfGoodsAndServicesSold"],
    "operating_income": ["OperatingIncomeLoss"],
    "net_income": ["NetIncomeLoss"],
    "operating_cash_flow": ["NetCashProvidedByUsedInOperatingActivities"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment"],
}
INSTANT = {
    "equity": ["StockholdersEquity"],
    "current_assets": ["AssetsCurrent"],
    "current_liabilities": ["LiabilitiesCurrent"],
}
DEBT_PAIRS = [("LongTermDebtNoncurrent", "LongTermDebtCurrent"), ("LongTermDebt", "DebtCurrent")]


def _days(a, b):
    return (date.fromisoformat(b) - date.fromisoformat(a)).days


def _facts(cf, concept, unit="USD", taxonomy="us-gaap"):
    return cf.get("facts", {}).get(taxonomy, {}).get(concept, {}).get("units", {}).get(unit, [])


def _known(facts, as_of):
    """Latest-filed value per period key, using only filings on or before as_of."""
    best = {}
    for f in facts:
        if f["filed"] > as_of:
            continue
        key = (f.get("start"), f["end"])
        if key not in best or f["filed"] > best[key]["filed"]:
            best[key] = f
    return best


def _quarters(cf, concepts, as_of, unit="USD"):
    """{quarter_end: (value, filed)} with Q4 derived from the fiscal year when missing."""
    for concept in concepts:
        known = _known(_facts(cf, concept, unit), as_of)
        if not known:
            continue
        q = {end: (f["val"], f["filed"]) for (start, end), f in known.items() if start and 80 <= _days(start, end) <= 100}
        # 10-Q cash-flow statements are year-to-date only: a quarter is the
        # difference of two YTD values sharing a start and ending ~90 days apart.
        by_start = {}
        for (start, end), f in known.items():
            if start:
                by_start.setdefault(start, []).append(f)
        for facts in by_start.values():
            facts.sort(key=lambda f: f["end"])
            for prev, cur in zip(facts, facts[1:]):
                if cur["end"] not in q and 80 <= _days(prev["end"], cur["end"]) <= 100:
                    q[cur["end"]] = (cur["val"] - prev["val"], max(prev["filed"], cur["filed"]))
        for (start, end), f in known.items():
            if start and 350 <= _days(start, end) <= 380 and end not in q:
                inside = [v for e, v in q.items() if start < e < end]
                if len(inside) == 3:
                    q[end] = (f["val"] - sum(v for v, _ in inside), f["filed"])
        return q
    return {}


def _instant(cf, concepts, end, as_of):
    for concept in concepts:
        f = _known(_facts(cf, concept), as_of).get((None, end))
        if f:
            return f["val"]
    return None


def _ttm(q, end):
    ends = sorted(e for e in q if e <= end)[-4:]
    if len(ends) < 4 or ends[-1] != end or _days(ends[0], end) > 300:
        return None, None
    return sum(q[e][0] for e in ends), max(q[e][1] for e in ends)


def _div(a, b):
    return a / b if a is not None and b not in (None, 0) else None


def _shares(cf, end, as_of):
    facts = [f for f in _facts(cf, "EntityCommonStockSharesOutstanding", "shares", "dei") if f["filed"] <= as_of and f["end"] >= end]
    if facts:
        return min(facts, key=lambda f: f["end"])["val"]
    q = _quarters(cf, ["WeightedAverageNumberOfDilutedSharesOutstanding"], as_of, "shares")
    return q[end][0] if end in q else None


def ttm_rows(cf, as_of, limit):
    q = {name: _quarters(cf, concepts, as_of) for name, concepts in DURATION.items()}
    eps = _quarters(cf, ["EarningsPerShareDiluted"], as_of, "USD/shares")
    anchor = q["revenue"] or q["net_income"]
    rows = []
    for end in sorted(anchor, reverse=True):
        ttm = {name: _ttm(series, end) for name, series in q.items()}
        revenue, filed = ttm["revenue"] if ttm["revenue"][0] is not None else ttm["net_income"]
        if filed is None:
            continue
        gross = ttm["gross_profit"][0]
        if gross is None and revenue is not None and ttm["cost_of_revenue"][0] is not None:
            gross = revenue - ttm["cost_of_revenue"][0]
        equity = _instant(cf, INSTANT["equity"], end, as_of)
        debt = None
        for a, b in DEBT_PAIRS:
            va, vb = _instant(cf, [a], end, as_of), _instant(cf, [b], end, as_of)
            if va is not None or vb is not None:
                debt = (va or 0) + (vb or 0)
                break
        shares = _shares(cf, end, as_of)
        prior = sorted(e for e in anchor if e < end and 350 <= _days(e, end) <= 380)
        prior_revenue = _ttm(q["revenue"], prior[-1])[0] if prior else None
        ocf, capex = ttm["operating_cash_flow"][0], ttm["capex"][0]
        rows.append({
            "report_period": end,
            "period": "ttm",
            "currency": "USD",
            "filing_date": filed,
            "gross_margin": _div(gross, revenue),
            "operating_margin": _div(ttm["operating_income"][0], revenue),
            "net_margin": _div(ttm["net_income"][0], revenue),
            "return_on_equity": _div(ttm["net_income"][0], equity),
            "debt_to_equity": _div(debt, equity),
            "current_ratio": _div(_instant(cf, INSTANT["current_assets"], end, as_of), _instant(cf, INSTANT["current_liabilities"], end, as_of)),
            "revenue_growth": _div(revenue, prior_revenue) - 1 if _div(revenue, prior_revenue) is not None else None,
            "earnings_per_share": _ttm(eps, end)[0],
            "book_value_per_share": _div(equity, shares),
            "free_cash_flow_per_share": _div(ocf - capex, shares) if ocf is not None and capex is not None else None,
            "market_cap": None,
            "price_to_earnings_ratio": None,
            "_shares": shares,
            "_net_income_ttm": ttm["net_income"][0],
        })
        if len(rows) == limit:
            break
    return rows


def close_lookup(bars):
    days = sorted((b["time"][:10], b["close"]) for b in bars)
    keys = [d for d, _ in days]

    def lookup(day):
        i = bisect_right(keys, day)
        return days[i - 1][1] if i else None

    return lookup


def add_valuation(rows, lookup):
    for row in rows:
        close = lookup(row["filing_date"])
        cap = row["_shares"] * close if row["_shares"] is not None and close is not None else None
        row["market_cap"] = cap
        income = row["_net_income_ttm"]
        row["price_to_earnings_ratio"] = cap / income if cap is not None and income and income > 0 else None


def public_row(ticker, row):
    return {"ticker": ticker, **{k: v for k, v in row.items() if not k.startswith("_")}}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `cd ai-trading/market-data && python3 -m unittest test_metrics -v`
Expected: all OK. If a fixture expectation and the spec disagree, the spec wins; ledger the ruling.

- [ ] **Step 5: Commit.** `git add ai-trading/market-data/metrics.py ai-trading/market-data/errors.py ai-trading/market-data/test_metrics.py && git commit -m "feat(ai-trading): point-in-time TTM metrics from SEC facts"`

### Task 2: HTTP server and error contract

**Files:**
- Create: `ai-trading/market-data/server.py`
- Test: `ai-trading/market-data/test_server.py`

**Interfaces:**
- Consumes: Task 1's `metrics.ttm_rows`, `add_valuation`, `close_lookup`, `public_row`.
- Produces: `errors.ProviderError(Exception)`, `errors.Unsupported(Exception)`; `server.make_server(port, token, prices, fundamentals) -> ThreadingHTTPServer`. `prices.daily_bars(ticker, start, end, adjustment) -> list[dict]` (keys `open, close, high, low, volume, time`); `fundamentals.companyfacts(ticker) -> dict | None`; `fundamentals.facts(ticker) -> dict | None`.

- [ ] **Step 1: Write the failing tests** (`test_server.py`):

```python
import json
import threading
import unittest
import urllib.error
import urllib.request

import server
from errors import ProviderError

TOKEN = "test-token"


class FakePrices:
    def __init__(self, bars=None, error=None):
        self.bars, self.error, self.calls = bars or [], error, []

    def daily_bars(self, ticker, start, end, adjustment):
        self.calls.append((ticker, start, end, adjustment))
        if self.error:
            raise self.error
        return self.bars


class FakeFundamentals:
    def __init__(self, companyfacts=None, facts=None):
        self._cf, self._facts = companyfacts, facts

    def companyfacts(self, ticker):
        return self._cf

    def facts(self, ticker):
        return self._facts


def get(port, path, key=TOKEN):
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"X-API-Key": key} if key is not None else {})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class ServerTest(unittest.TestCase):
    def start(self, prices=None, fundamentals=None):
        srv = server.make_server(0, TOKEN, prices or FakePrices(), fundamentals or FakeFundamentals())
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return srv.server_address[1]

    def test_healthz_needs_no_key(self):
        self.assertEqual(get(self.start(), "/healthz", key=None)[0], 200)

    def test_bad_missing_or_non_ascii_key_is_401(self):
        port = self.start()
        for key in ("wrong", "", None):
            self.assertEqual(get(port, "/prices/?ticker=AAPL&start_date=2024-01-01&end_date=2024-01-31", key=key)[0], 401)
        req = urllib.request.Request(f"http://127.0.0.1:{port}/prices/?ticker=AAPL", headers={"X-API-Key": "é".encode("latin-1")})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req)
        self.assertEqual(ctx.exception.code, 401)

    def test_prices_shape_and_split_adjustment(self):
        bar = {"open": 1.0, "close": 2.0, "high": 3.0, "low": 0.5, "volume": 10, "time": "2024-01-02T05:00:00Z"}
        prices = FakePrices([bar])
        status, body = get(self.start(prices), "/prices/?ticker=AAPL&interval=day&interval_multiplier=1&start_date=2024-01-01&end_date=2024-01-31")
        self.assertEqual((status, body), (200, {"prices": [bar]}))
        self.assertEqual(prices.calls, [("AAPL", "2024-01-01", "2024-01-31", "split")])

    def test_non_daily_interval_is_501(self):
        self.assertEqual(get(self.start(), "/prices/?ticker=AAPL&interval=minute&start_date=2024-01-01&end_date=2024-01-02")[0], 501)

    def test_unsupported_endpoints_and_unknown_paths_are_501(self):
        port = self.start()
        for path in ("/earnings/?ticker=AAPL&limit=1", "/news/?ticker=AAPL&end_date=2024-01-01", "/insider-trades/?ticker=AAPL&filing_date_lte=2024-01-01", "/nope/"):
            self.assertEqual(get(port, path)[0], 501, path)

    def test_provider_error_is_502(self):
        port = self.start(prices=FakePrices(error=ProviderError("Alpaca is not configured")))
        status, body = get(port, "/prices/?ticker=AAPL&start_date=2024-01-01&end_date=2024-01-31")
        self.assertEqual(status, 502)
        self.assertIn("Alpaca is not configured", body["error"])

    def test_missing_param_or_bad_ticker_is_400(self):
        port = self.start()
        self.assertEqual(get(port, "/prices/?ticker=AAPL")[0], 400)
        self.assertEqual(get(port, "/prices/?ticker=../x&start_date=2024-01-01&end_date=2024-01-02")[0], 400)

    def test_company_facts_shape_and_unknown_ticker(self):
        facts = {"ticker": "AAPL", "name": "Apple Inc.", "cik": "320193"}
        self.assertEqual(get(self.start(fundamentals=FakeFundamentals(facts=facts)), "/company/facts/?ticker=AAPL"), (200, {"company_facts": facts}))
        self.assertEqual(get(self.start(), "/company/facts/?ticker=ZZZZ"), (200, {"company_facts": None}))

    def test_metrics_period_other_than_ttm_is_501(self):
        self.assertEqual(get(self.start(), "/financial-metrics/?ticker=AAPL&filing_date_lte=2024-01-01&period=annual")[0], 501)

    def test_metrics_with_no_filings_is_empty_list(self):
        self.assertEqual(get(self.start(), "/financial-metrics/?ticker=AAPL&filing_date_lte=2024-01-01&period=ttm&limit=4"), (200, {"financial_metrics": []}))

    def test_empty_token_refuses_to_start(self):
        with self.assertRaises(ValueError):
            server.make_server(0, "", FakePrices(), FakeFundamentals())


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails.**

Run: `cd ai-trading/market-data && python3 -m unittest test_server -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'server'`.

- [ ] **Step 3: Implement.** `errors.py` exists from Task 1. `server.py`:

```python
"""Financial Datasets-shaped API for ai-hedge-fund (01m). Stdlib only."""
import hmac
import json
import os
import re
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import metrics
from errors import ProviderError, Unsupported

TICKER = re.compile(r"^[A-Z0-9][A-Z0-9.\-]{0,9}$")
UNSUPPORTED_PATHS = {"/earnings/", "/news/", "/insider-trades/"}


def _ticker(q):
    ticker = q["ticker"].upper()
    if not TICKER.match(ticker):
        raise ValueError("ticker")
    return ticker


def prices_route(q, prices):
    if q.get("interval", "day") != "day" or q.get("interval_multiplier", "1") != "1":
        raise Unsupported("only interval=day with interval_multiplier=1 is supported")
    start, end = date.fromisoformat(q["start_date"]), date.fromisoformat(q["end_date"])
    return {"prices": prices.daily_bars(_ticker(q), start.isoformat(), end.isoformat(), "split")}


def metrics_route(q, prices, fundamentals):
    if q.get("period", "ttm") != "ttm":
        raise Unsupported("only period=ttm is supported")
    ticker, as_of, limit = _ticker(q), date.fromisoformat(q["filing_date_lte"]).isoformat(), int(q.get("limit", "10"))
    cf = fundamentals.companyfacts(ticker)
    rows = metrics.ttm_rows(cf, as_of, limit) if cf else []
    if rows:
        days = [r["filing_date"] for r in rows]
        start = (date.fromisoformat(min(days)) - timedelta(days=10)).isoformat()
        bars = prices.daily_bars(ticker, start, max(days), "raw")
        metrics.add_valuation(rows, metrics.close_lookup(bars))
    return {"financial_metrics": [metrics.public_row(ticker, r) for r in rows]}


def facts_route(q, fundamentals):
    return {"company_facts": fundamentals.facts(_ticker(q))}


def make_server(port, token, prices, fundamentals):
    if not token:
        raise ValueError("MARKET_DATA_TOKEN must be set")
    expected = token.encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/healthz":
                return self._send(200, {"status": "ok"})
            given = self.headers.get("X-API-Key", "").encode("utf-8", "surrogateescape")
            if not hmac.compare_digest(given, expected):
                return self._send(401, {"error": "invalid API key"})
            q = {k: v[0] for k, v in parse_qs(url.query).items()}
            try:
                if url.path == "/prices/":
                    body = prices_route(q, prices)
                elif url.path == "/financial-metrics/":
                    body = metrics_route(q, prices, fundamentals)
                elif url.path == "/company/facts/":
                    body = facts_route(q, fundamentals)
                elif url.path in UNSUPPORTED_PATHS:
                    raise Unsupported(f"{url.path} is not supported by the family market-data service")
                else:
                    raise Unsupported(f"unknown path {url.path}")
            except Unsupported as e:
                return self._send(501, {"error": str(e)})
            except ProviderError as e:
                return self._send(502, {"error": str(e)})
            except (KeyError, ValueError) as e:
                return self._send(400, {"error": f"bad request: {e}"})
            self._send(200, body)

        def _send(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt, *args):  # no query strings in logs
            pass

    return ThreadingHTTPServer(("0.0.0.0", port), Handler)


if __name__ == "__main__":
    from alpaca import AlpacaPrices
    from sec import SecFundamentals

    providers = {"alpaca": lambda: AlpacaPrices(os.environ.get("ALPACA_API_KEY_ID", ""), os.environ.get("ALPACA_API_SECRET_KEY", ""))}
    fundamentals = {"sec": lambda: SecFundamentals(os.environ.get("SEC_USER_AGENT", ""))}
    price_name, fund_name = os.environ.get("PRICE_PROVIDER", "alpaca"), os.environ.get("FUNDAMENTALS_PROVIDER", "sec")
    if price_name not in providers or fund_name not in fundamentals:
        raise SystemExit(f"unknown provider: PRICE_PROVIDER={price_name} FUNDAMENTALS_PROVIDER={fund_name}")
    make_server(8000, os.environ.get("MARKET_DATA_TOKEN", ""), providers[price_name](), fundamentals[fund_name]()).serve_forever()
```


- [ ] **Step 4: Run to verify it passes.**

Run: `cd ai-trading/market-data && python3 -m unittest test_server -v`
Expected: 11 tests OK.

- [ ] **Step 5: Commit.** `git add ai-trading/market-data/server.py ai-trading/market-data/test_server.py && git commit -m "feat(ai-trading): market-data server and error contract"`

### Task 3: SEC EDGAR provider

**Files:**
- Create: `ai-trading/market-data/sec.py`
- Test: `ai-trading/market-data/test_sec.py`

**Interfaces:**
- Produces: `SecFundamentals(user_agent, fetch=None, now=time.monotonic, sleep=time.sleep, ttl=86400)` with `companyfacts(ticker)` and `facts(ticker)`. `fetch(url, headers) -> (status, bytes)` is injectable; the default uses `urllib.request`.

- [ ] **Step 1: Write the failing tests** (`test_sec.py`), with a fake `fetch` that records calls:

```python
import json
import unittest

from errors import ProviderError
from sec import SecFundamentals

TICKERS = {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."}}
SUBMISSIONS = {"cik": "320193", "name": "Apple Inc.", "sic": "3571", "sicDescription": "Electronic Computers", "exchanges": ["Nasdaq"]}


class FakeFetch:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, headers):
        self.calls.append((url, headers))
        status, body = self.routes.get(url, (404, {}))
        return status, json.dumps(body).encode()


def routes(**extra):
    r = {
        "https://www.sec.gov/files/company_tickers.json": (200, TICKERS),
        "https://data.sec.gov/submissions/CIK0000320193.json": (200, SUBMISSIONS),
        "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json": (200, {"facts": {}}),
    }
    r.update(extra)
    return r


class SecTest(unittest.TestCase):
    def make(self, r=None):
        fetch = FakeFetch(r or routes())
        return SecFundamentals("Family test test@example.test", fetch=fetch, sleep=lambda s: None), fetch

    def test_user_agent_sent_and_required(self):
        sec, fetch = self.make()
        sec.companyfacts("AAPL")
        self.assertTrue(all(h["User-Agent"] == "Family test test@example.test" for _, h in fetch.calls))
        with self.assertRaises(ProviderError):
            SecFundamentals("", fetch=fetch).companyfacts("AAPL")

    def test_facts_maps_sic_to_sector_and_industry(self):
        sec, _ = self.make()
        self.assertEqual(sec.facts("aapl"), {
            "ticker": "AAPL", "name": "Apple Inc.", "cik": "320193", "is_active": True,
            "sic_code": "3571", "sic_industry": "Electronic Computers", "industry": "Electronic Computers",
            "sic_sector": "Manufacturing", "sector": "Manufacturing", "exchange": "Nasdaq",
        })

    def test_unknown_ticker_and_no_xbrl_are_none(self):
        sec, _ = self.make()
        self.assertIsNone(sec.facts("ZZZZ"))
        self.assertIsNone(sec.companyfacts("ZZZZ"))
        sec, _ = self.make(routes(**{"https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json": (404, {})}))
        self.assertIsNone(sec.companyfacts("AAPL"))

    def test_server_error_is_provider_error(self):
        sec, _ = self.make(routes(**{"https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json": (503, {})}))
        with self.assertRaises(ProviderError):
            sec.companyfacts("AAPL")

    def test_responses_are_cached(self):
        sec, fetch = self.make()
        sec.companyfacts("AAPL")
        sec.companyfacts("AAPL")
        self.assertEqual(len(fetch.calls), 2)   # tickers map + companyfacts, once each


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails.** `cd ai-trading/market-data && python3 -m unittest test_sec -v` → `ModuleNotFoundError: No module named 'sec'`.

- [ ] **Step 3: Implement** `sec.py`:

```python
"""SEC EDGAR fundamentals provider (01m §5.4). 10 requests/s, 24 h cache."""
import json
import threading
import time
import urllib.error
import urllib.request

from errors import ProviderError

SIC_DIVISIONS = [
    (100, 999, "Agriculture, Forestry and Fishing"), (1000, 1499, "Mining"), (1500, 1799, "Construction"),
    (2000, 3999, "Manufacturing"), (4000, 4999, "Transportation, Communications, Electric, Gas and Sanitary Services"),
    (5000, 5199, "Wholesale Trade"), (5200, 5999, "Retail Trade"), (6000, 6799, "Finance, Insurance and Real Estate"),
    (7000, 8999, "Services"), (9100, 9729, "Public Administration"), (9900, 9999, "Nonclassifiable"),
]


def _urllib_fetch(url, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, TimeoutError) as e:
        raise ProviderError(f"SEC unreachable: {e}") from e


def _sector(sic):
    try:
        code = int(sic)
    except (TypeError, ValueError):
        return None
    return next((name for lo, hi, name in SIC_DIVISIONS if lo <= code <= hi), None)


class SecFundamentals:
    def __init__(self, user_agent, fetch=None, now=time.monotonic, sleep=time.sleep, ttl=86400):
        self.user_agent, self.fetch, self.now, self.sleep, self.ttl = user_agent, fetch or _urllib_fetch, now, sleep, ttl
        self._cache, self._lock, self._last = {}, threading.Lock(), 0.0

    def _get(self, url):
        if not self.user_agent:
            raise ProviderError("SEC_USER_AGENT is not configured")
        with self._lock:
            hit = self._cache.get(url)
            if hit and self.now() - hit[0] < self.ttl:
                return hit[1]
            wait = 0.1 - (self.now() - self._last)
            if wait > 0:
                self.sleep(wait)
            self._last = self.now()
            status, body = self.fetch(url, {"User-Agent": self.user_agent})
            if status == 404:
                data = None
            elif status != 200:
                raise ProviderError(f"SEC returned {status} for {url}")
            else:
                data = json.loads(body)
            self._cache[url] = (self.now(), data)
            return data

    def _cik(self, ticker):
        tickers = self._get("https://www.sec.gov/files/company_tickers.json") or {}
        ticker = ticker.upper()
        row = next((r for r in tickers.values() if r["ticker"] == ticker), None)
        return f"{row['cik_str']:010d}" if row else None

    def companyfacts(self, ticker):
        cik = self._cik(ticker)
        return self._get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json") if cik else None

    def facts(self, ticker):
        cik = self._cik(ticker)
        sub = self._get(f"https://data.sec.gov/submissions/CIK{cik}.json") if cik else None
        if not sub:
            return None
        sector = _sector(sub.get("sic"))
        return {
            "ticker": ticker.upper(), "name": sub.get("name"), "cik": str(int(cik)), "is_active": True,
            "sic_code": sub.get("sic"), "sic_industry": sub.get("sicDescription"), "industry": sub.get("sicDescription"),
            "sic_sector": sector, "sector": sector, "exchange": (sub.get("exchanges") or [None])[0],
        }
```

- [ ] **Step 4: Run to verify it passes.** `python3 -m unittest test_sec -v` → 5 OK.
- [ ] **Step 5: Commit.** `git add ai-trading/market-data/sec.py ai-trading/market-data/test_sec.py && git commit -m "feat(ai-trading): SEC EDGAR fundamentals provider"`

### Task 4: Alpaca price provider

**Files:**
- Create: `ai-trading/market-data/alpaca.py`
- Test: `ai-trading/market-data/test_alpaca.py`

**Interfaces:**
- Produces: `AlpacaPrices(key_id, secret, fetch=None, sleep=time.sleep, today=None)`; `daily_bars(ticker, start, end, adjustment) -> list[dict]`. `fetch(url, headers) -> (status, bytes)`; `today() -> date` (New York).

- [ ] **Step 1: Write the failing tests** (`test_alpaca.py`):

```python
import json
import unittest
from datetime import date
from urllib.parse import parse_qs, urlparse

from alpaca import AlpacaPrices
from errors import ProviderError


def bar(day, close):
    return {"t": f"{day}T05:00:00Z", "o": 1, "h": 2, "l": 0.5, "c": close, "v": 100, "n": 5, "vw": 1.5}


class FakeFetch:
    def __init__(self, pages):
        self.pages, self.calls = list(pages), []

    def __call__(self, url, headers):
        self.calls.append((url, headers))
        status, body = self.pages.pop(0)
        return status, json.dumps(body).encode()


def make(pages, today=date(2024, 2, 1)):
    fetch = FakeFetch(pages)
    return AlpacaPrices("kid", "sec", fetch=fetch, sleep=lambda s: None, today=lambda: today), fetch


class AlpacaTest(unittest.TestCase):
    def test_maps_bars_and_follows_pagination(self):
        prices, fetch = make([(200, {"bars": [bar("2024-01-02", 10)], "next_page_token": "p2"}), (200, {"bars": [bar("2024-01-03", 11)], "next_page_token": None})])
        got = prices.daily_bars("AAPL", "2024-01-01", "2024-01-31", "split")
        self.assertEqual(got, [
            {"open": 1, "close": 10, "high": 2, "low": 0.5, "volume": 100, "time": "2024-01-02T05:00:00Z"},
            {"open": 1, "close": 11, "high": 2, "low": 0.5, "volume": 100, "time": "2024-01-03T05:00:00Z"},
        ])
        q = parse_qs(urlparse(fetch.calls[1][0]).query)
        self.assertEqual(q["page_token"], ["p2"])
        self.assertEqual((q["timeframe"], q["adjustment"], q["feed"]), (["1Day"], ["split"], ["sip"]))
        self.assertEqual(fetch.calls[0][1], {"APCA-API-KEY-ID": "kid", "APCA-API-SECRET-KEY": "sec"})

    def test_end_capped_at_yesterday_new_york(self):
        prices, fetch = make([(200, {"bars": [bar("2024-01-31", 9), bar("2024-02-01", 99)]})])
        got = prices.daily_bars("AAPL", "2024-01-30", "2024-02-01", "raw")
        self.assertEqual([b["close"] for b in got], [9])
        self.assertEqual(parse_qs(urlparse(fetch.calls[0][0]).query)["end"], ["2024-02-01"])   # exclusive bound = day after 2024-01-31

    def test_start_after_capped_end_returns_empty_without_calling(self):
        prices, fetch = make([])
        self.assertEqual(prices.daily_bars("AAPL", "2024-02-01", "2024-02-01", "split"), [])
        self.assertEqual(fetch.calls, [])

    def test_retries_429_then_succeeds(self):
        prices, fetch = make([(429, {}), (200, {"bars": None})])
        self.assertEqual(prices.daily_bars("AAPL", "2024-01-01", "2024-01-31", "split"), [])
        self.assertEqual(len(fetch.calls), 2)

    def test_errors_and_missing_keys_raise_provider_error(self):
        prices, _ = make([(429, {})] * 4)
        with self.assertRaises(ProviderError):
            prices.daily_bars("AAPL", "2024-01-01", "2024-01-31", "split")
        prices, _ = make([(403, {"message": "forbidden"})])
        with self.assertRaises(ProviderError):
            prices.daily_bars("AAPL", "2024-01-01", "2024-01-31", "split")
        with self.assertRaises(ProviderError):
            AlpacaPrices("", "").daily_bars("AAPL", "2024-01-01", "2024-01-31", "split")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to verify it fails.** `python3 -m unittest test_alpaca -v` → `ModuleNotFoundError: No module named 'alpaca'`.

- [ ] **Step 3: Implement** `alpaca.py`:

```python
"""Alpaca daily bars (01m §5.3). Completed New York sessions only."""
import json
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from urllib.parse import quote, urlencode
from zoneinfo import ZoneInfo

from errors import ProviderError

BASE = "https://data.alpaca.markets/v2/stocks"
RETRY_DELAYS = (1, 2, 4)


def _urllib_fetch(url, headers):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, TimeoutError) as e:
        raise ProviderError(f"Alpaca unreachable: {e}") from e


class AlpacaPrices:
    def __init__(self, key_id, secret, fetch=None, sleep=time.sleep, today=None):
        self.key_id, self.secret, self.fetch, self.sleep = key_id, secret, fetch or _urllib_fetch, sleep
        self.today = today or (lambda: datetime.now(ZoneInfo("America/New_York")).date())

    def daily_bars(self, ticker, start, end, adjustment):
        if not (self.key_id and self.secret):
            raise ProviderError("Alpaca is not configured")
        last = min(date.fromisoformat(end), self.today() - timedelta(days=1)).isoformat()
        if start > last:
            return []
        params = {"timeframe": "1Day", "start": start, "end": (date.fromisoformat(last) + timedelta(days=1)).isoformat(),
                  "adjustment": adjustment, "feed": "sip", "limit": "10000"}
        bars = []
        while True:
            body = self._get(f"{BASE}/{quote(ticker)}/bars?{urlencode(params)}")
            for b in body.get("bars") or []:
                if start <= b["t"][:10] <= last:
                    bars.append({"open": b["o"], "close": b["c"], "high": b["h"], "low": b["l"], "volume": int(b["v"]), "time": b["t"]})
            token = body.get("next_page_token")
            if not token:
                return bars
            params["page_token"] = token

    def _get(self, url):
        headers = {"APCA-API-KEY-ID": self.key_id, "APCA-API-SECRET-KEY": self.secret}
        for delay in (*RETRY_DELAYS, None):
            status, body = self.fetch(url, headers)
            if status == 429 and delay is not None:
                self.sleep(delay)
                continue
            if status != 200:
                raise ProviderError(f"Alpaca returned {status}")
            return json.loads(body)
```

- [ ] **Step 4: Run to verify it passes.** `python3 -m unittest discover -v` (in `ai-trading/market-data`) → all OK.
- [ ] **Step 5: Commit.** `git add ai-trading/market-data/alpaca.py ai-trading/market-data/test_alpaca.py && git commit -m "feat(ai-trading): Alpaca daily bars provider"`

### Task 5: Image, compose, ai-hedge-fund wiring, deploy, CI

**Files:**
- Create: `ai-trading/market-data/Dockerfile`, `ai-trading/deploy/upstream/ai-hedge-fund/sitecustomize.py`
- Modify: `ai-trading/deploy/upstream/ai-hedge-fund/Dockerfile`, `ai-trading/deploy/docker-bake.hcl` (target + default group), `ai-trading/deploy/production/docker-compose.yml` (service + `FD_BASE_URL` on `ahf-terminal`), `ai-trading/deploy/production/deploy.sh` (render + `SECRET_FILES`), `ai-trading/deploy/ci/smoke-test.sh` (`smoke_market_data`), `.github/workflows/ai-trading-ci.yml` (unit tests in the `scripts` job), `.github/workflows/ai-trading-deploy.yml` only if it lists images explicitly
- Test: `ai-trading/deploy/ci/test-deploy-firestore.sh` (existing suite), `smoke-test.sh market-data`

- [ ] **Step 1: Failing smoke first.** Add to `smoke-test.sh`, and call it from `all` after `smoke_terminal ahf-terminal ...` plus a `market-data)` case:

```bash
smoke_market_data() {
  local net="smoke-md-net"
  docker network rm "$net" >/dev/null 2>&1 || true
  docker network create "$net" >/dev/null
  docker run -d --name smoke-market-data --network "$net" --network-alias market-data \
    -e MARKET_DATA_TOKEN=smoke-token "$(image market-data)" >/dev/null
  containers+=(smoke-market-data)
  # Real upstream FDClient, repointed by the wrapper's sitecustomize, against the
  # real service with no provider keys: earnings 501, prices 502, bad key 401.
  docker run --rm --network "$net" -e FD_BASE_URL=http://market-data:8000 -e FINANCIAL_DATASETS_API_KEY=smoke-token \
    --entrypoint python "$(image ahf-terminal)" -c '
import time, urllib.request
for _ in range(30):
    try:
        urllib.request.urlopen("http://market-data:8000/healthz", timeout=2); break
    except Exception:
        time.sleep(1)
from hedge_fund.data import FDClient, FDClientError
assert FDClient.BASE_URL == "http://market-data:8000", FDClient.BASE_URL
def status(call):
    try:
        call(); return 200
    except FDClientError as e:
        return e.status_code
fd = FDClient()
assert status(lambda: fd.get_earnings("AAPL")) == 501
assert status(lambda: fd.get_prices("AAPL", "2024-01-01", "2024-01-31")) == 502
assert status(lambda: FDClient(api_key="wrong").get_prices("AAPL", "2024-01-01", "2024-01-31")) == 401
' || fail "ai-hedge-fund FDClient against market-data"
  echo "ok   ai-hedge-fund FDClient reaches market-data: 501/502/401 contract"
  docker rm -f smoke-market-data >/dev/null
  docker network rm "$net" >/dev/null 2>&1 || true
}
```

Run (after `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load ahf-terminal`): `ai-trading/deploy/ci/smoke-test.sh market-data` → FAIL (no `market-data` image).

- [ ] **Step 2: Image and wiring.**

`ai-trading/market-data/Dockerfile` (same base digest as the ahf wrapper):

```dockerfile
# syntax=docker/dockerfile:1.7
ARG PYTHON_IMAGE=python:3.11-slim-trixie@sha256:6f31d6e9ba2b0a787a3f81c37b004155b87b9efa1b771182bd550c1615745be5
FROM ${PYTHON_IMAGE}
RUN useradd --create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY server.py metrics.py errors.py sec.py alpaca.py ./
USER app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/healthz', timeout=4)"
CMD ["python", "server.py"]
```

`docker-bake.hcl`: add `"market-data"` to the `default` group's targets and

```hcl
target "market-data" {
  context = "ai-trading/market-data"
  tags    = ["${REGISTRY}/ai-trading-market-data:${TAG}"]
}
```

`deploy/upstream/ai-hedge-fund/sitecustomize.py`:

```python
# Repoints upstream's Financial Datasets client at the family market-data
# service (01m) without editing upstream. Loaded by `site` at every start.
import os

_url = os.environ.get("FD_BASE_URL")
if _url:
    import hedge_fund.data.client as _client

    _client.FDClient.BASE_URL = _url.rstrip("/")
```

ahf `Dockerfile`, after `COPY --from=build /opt/venv /opt/venv`: `COPY sitecustomize.py /opt/venv/lib/python3.11/site-packages/sitecustomize.py`.

`docker-compose.yml`: on `ahf-terminal` add `environment: { FD_BASE_URL: "http://market-data:8000" }`, and a service:

```yaml
  market-data:
    image: ${AI_TRADING_REGISTRY:-ghcr.io/thangtran3112/family-app}/ai-trading-market-data:${AI_TRADING_IMAGE_TAG:?AI_TRADING_IMAGE_TAG is required}
    restart: unless-stopped
    env_file:
      - ${AI_TRADING_SECRETS_DIR:-/etc/family-app/ai-trading}/market-data.env
    networks: [ahf]
    mem_limit: 256m
    pids_limit: 128
    read_only: true
    security_opt: ["no-new-privileges:true"]
```

`deploy.sh`: add `ai-trading/market-data` to the `render` call in `render_profiles` and `market-data.env` to `SECRET_FILES`. If `health-check.sh` lists services explicitly, add `market-data`.

`ai-trading-ci.yml` `scripts` job: a step `Market data tests` running `cd ai-trading/market-data && python3 -m unittest discover -v`. Add `market-data` wherever the deploy workflow or CI enumerates image names (grep `ahf-terminal` in both workflows).

- [ ] **Step 3: Verify.** `docker buildx bake -f ai-trading/deploy/docker-bake.hcl --load market-data ahf-terminal && ai-trading/deploy/ci/smoke-test.sh market-data` → `ok   ai-hedge-fund FDClient reaches market-data`. `ai-trading/deploy/ci/test-deploy-firestore.sh` → GREEN (the fake renders any profile; `market-data.env` joins the six files). `shellcheck` on both scripts. `ai-trading/deploy/ci/smoke-test.sh ahf-terminal` still passes (sitecustomize is a no-op without `FD_BASE_URL`).

- [ ] **Step 4: Commit.** `git add` the files above and `git commit -m "feat(ai-trading): market-data container wired into ai-hedge-fund"`

### Task 6: Firestore, ship, live checks

- [ ] **Step 1: Firestore** (must exist before the deploy, or `render_profiles` fails the whole deploy):
  - `python3 -c 'import secrets; print(secrets.token_hex(32))' | common/config/family_config.py set ai-trading/market-data MARKET_DATA_TOKEN`
  - `common/config/family_config.py link ai-trading/ai-hedge-fund FINANCIAL_DATASETS_API_KEY ai-trading/market-data:MARKET_DATA_TOKEN` (check `family_config.py link --help` for the exact syntax first).
  - `SEC_USER_AGENT`: ask the owner for the name and contact address; set it with `printf '%s' "$VALUE" | ... set ai-trading/market-data SEC_USER_AGENT`.
  - Alpaca: the owner creates a free Alpaca account and a data API key pair and sets `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` the same way. Until then prices and metrics return 502 and the rest works.
- [ ] **Step 2: Full local verification and review.** `smoke-test.sh all` with real images; one fresh whole-branch reviewer.
- [ ] **Step 3: PR, scoped release, push deploy** (MiroFish stays on through `keep`).
- [ ] **Step 4: Live checks** from inside `ahf-terminal` (`docker exec -i ai-trading-ahf-terminal-1 python - < check.py`): prices for AAPL over a past month; metrics for AAPL as of a past date with plausible values (spot-check one quarter's revenue and diluted EPS against the 10-Q); company facts; a `FundamentalsSnapshot` builds for AAPL with no LLM call; one short persona backtest from the TUI with a real model call (sponsored key); PEAD shows the 501 "not supported" error. Containers healthy, zero restarts, expense untouched.
