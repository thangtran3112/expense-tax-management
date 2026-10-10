"""Point-in-time TTM metrics from SEC companyfacts (01m §5.4). Provider-independent."""
from bisect import bisect_right
from datetime import date

DURATION = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenuesNetOfInterestExpense"],
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
    """Per period key: the latest-filed value on or before as_of (restatements
    count once public), with "first" = when that period was first made public
    (a later comparative re-report must not move the row's filing date)."""
    best = {}
    for f in facts:
        if f["filed"] > as_of:
            continue
        key = (f.get("start"), f["end"])
        cur = best.get(key)
        if cur is None:
            best[key] = {**f, "first": f["filed"]}
        else:
            first = min(cur["first"], f["filed"])
            best[key] = {**(f if f["filed"] > cur["filed"] else cur), "first": first}
    return best


def _concept_quarters(known):
    """{quarter_end: (value, first_public)} for one concept, with quarters
    derived from year-to-date pairs and Q4 from the fiscal year when missing."""
    q = {end: (f["val"], f["first"]) for (start, end), f in known.items() if start and 80 <= _days(start, end) <= 100}
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
                q[cur["end"]] = (cur["val"] - prev["val"], max(prev["first"], cur["first"]))
    for (start, end), f in known.items():
        if start and 350 <= _days(start, end) <= 380 and end not in q:
            inside = [v for e, v in q.items() if start < e < end]
            if len(inside) == 3:
                q[end] = (f["val"] - sum(v for v, _ in inside), max([f["first"]] + [d for _, d in inside]))
    return q


def _quarters(cf, concepts, as_of, unit="USD"):
    """Quarters merged across concepts per period (filers switch concepts over
    time, e.g. Revenues -> RevenueFromContractWithCustomer... in 2018); the
    earlier concept in the list wins a period both report."""
    merged = {}
    for concept in concepts:
        for end, value in _concept_quarters(_known(_facts(cf, concept, unit), as_of)).items():
            merged.setdefault(end, value)
    return merged


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
    anchor = set(q["revenue"]) | set(q["net_income"])
    rows = []
    for end in sorted(anchor, reverse=True):
        ttm = {name: _ttm(series, end) for name, series in q.items()}
        revenue = ttm["revenue"][0]
        dates = [d for _, d in (ttm["revenue"], ttm["net_income"]) if d is not None]
        if not dates:
            continue
        filed = max(dates)
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
