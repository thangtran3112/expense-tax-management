# /// script
# requires-python = ">=3.12"
# dependencies = ["ib_async==2.1.0"]
# ///
"""Read-only IBKR probe for the Family Desk verification spike (02a section 12).

Connects to a running IB Gateway or TWS session and prints one JSON report:
- the account prefix (paper accounts start with "DU"), with account IDs masked;
- the market-data type and update rate that each stock and futures symbol receives;
- one year of daily implied-volatility history for one stock;
- whether 1-minute bars exist 5, 30, and 180 days back for one stock and one future;
- how long one batch of option quotes takes to return model greeks;
- the news providers the session can read.

It never places orders and never requests positions, balances, or account values.
Usage: uv run ai-trading/tools/ibkr-probe/probe.py --port 4002 [--out ai-trading/temp/spike/probe.json]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import statistics
import sys
import time
from datetime import UTC, date, datetime, timedelta
from itertools import pairwise
from typing import Any

MARKET_DATA_TYPES = {1: "live", 2: "frozen", 3: "delayed", 4: "delayed-frozen"}
ACCOUNT_RE = re.compile(r"\b(?:DU|DF|DI|U|F|I)\d{5,}\b")


def mask_account(account: str) -> str:
    """Keep the letter prefix that tells paper ("DU") from live ("U"); hide the digits."""
    prefix = re.match(r"[A-Z]*", account).group(0)
    return prefix + "*" * (len(account) - len(prefix))


def redact(text: str) -> str:
    """Mask anything that looks like an IBKR account ID inside free text, such as error messages."""
    return ACCOUNT_RE.sub(lambda match: mask_account(match.group(0)), text)


def market_data_type_label(code: int | None) -> str:
    return MARKET_DATA_TYPES.get(code or 0, "none")


def summarize_intervals(times: list[float]) -> dict[str, Any]:
    """Update count and the median and 90th-percentile gap, in ms, between update timestamps (s)."""
    gaps = sorted((b - a) * 1000 for a, b in pairwise(times) if b > a)
    if not gaps:
        return {"updates": len(times), "median_ms": None, "p90_ms": None}
    return {
        "updates": len(times),
        "median_ms": round(statistics.median(gaps)),
        "p90_ms": round(gaps[min(len(gaps) - 1, int(len(gaps) * 0.9))]),
    }


def pick_expirations(expirations: list[str], today: date, min_dte: int = 21, max_dte: int = 45, limit: int = 2) -> list[str]:
    """Expirations (YYYYMMDD) with days to expiry in [min_dte, max_dte], nearest first."""
    picked = [e for e in sorted(expirations) if min_dte <= (datetime.strptime(e, "%Y%m%d").date() - today).days <= max_dte]
    return picked[:limit]


def pick_call_strikes(strikes: list[float], spot: float, max_otm_pct: float = 0.10, limit: int = 10) -> list[float]:
    """Out-of-the-money call strikes from spot up to spot * (1 + max_otm_pct), nearest first."""
    return sorted(s for s in strikes if spot <= s <= spot * (1 + max_otm_pct))[:limit]


def _finite(value: Any) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(value)


async def _qualified(ib: Any, *contracts: Any) -> list[Any]:
    from ib_async import Contract

    result = await ib.qualifyContractsAsync(*contracts)
    return [c for c in result if isinstance(c, Contract) and c.conId]


async def _front_futures(ib: Any, specs: list[str]) -> list[Any]:
    """Resolve ROOT:EXCHANGE specs (for example ES:CME) to their current front-month contracts."""
    from ib_async import ContFuture, Future

    fronts = []
    for spec in specs:
        root, exchange = spec.split(":")
        continuous = await _qualified(ib, ContFuture(root, exchange))
        if continuous:
            fronts += await _qualified(ib, Future(conId=continuous[0].conId, exchange=exchange))
    return fronts


async def probe_streams(ib: Any, args: argparse.Namespace) -> list[dict[str, Any]]:
    from ib_async import Stock

    contracts = await _qualified(ib, *(Stock(s, "SMART", "USD") for s in args.stocks))
    contracts += await _front_futures(ib, args.futures)
    times: dict[int, list[float]] = {c.conId: [] for c in contracts}

    def on_pending(tickers: Any) -> None:
        now = time.monotonic()
        for ticker in tickers:
            if ticker.contract is not None and ticker.contract.conId in times:
                times[ticker.contract.conId].append(now)

    tickers = [ib.reqMktData(c) for c in contracts]
    ib.pendingTickersEvent += on_pending
    await asyncio.sleep(args.seconds)
    ib.pendingTickersEvent -= on_pending
    rows = []
    for ticker in tickers:
        contract = ticker.contract
        rows.append({
            "symbol": contract.localSymbol or contract.symbol,
            "sec_type": contract.secType,
            "data_type": market_data_type_label(ticker.marketDataType),
            "has_bid_ask": _finite(ticker.bid) and _finite(ticker.ask),
            **summarize_intervals(times[contract.conId]),
        })
        ib.cancelMktData(contract)
    return rows


async def probe_iv_history(ib: Any, symbol: str) -> dict[str, Any]:
    from ib_async import Stock

    stocks = await _qualified(ib, Stock(symbol, "SMART", "USD"))
    if not stocks:
        return {"symbol": symbol, "error": "could not qualify"}
    out: dict[str, Any] = {"symbol": symbol}
    for what in ("OPTION_IMPLIED_VOLATILITY", "HISTORICAL_VOLATILITY"):
        bars = await asyncio.wait_for(
            ib.reqHistoricalDataAsync(stocks[0], "", "1 Y", "1 day", what, True), timeout=90
        )
        out[what.lower()] = {"bars": len(bars), "first": str(bars[0].date) if bars else None, "last": str(bars[-1].date) if bars else None}
    return out


async def probe_minute_history(ib: Any, args: argparse.Namespace) -> list[dict[str, Any]]:
    """Does a 1-minute request ending N days ago return bars? This shows how far back intraday history goes."""
    from ib_async import Stock

    contracts = await _qualified(ib, Stock(args.iv_symbol, "SMART", "USD"))
    contracts += await _front_futures(ib, args.futures[:1])
    rows = []
    for contract in contracts:
        for days_back in (5, 30, 180):
            end = (datetime.now(UTC) - timedelta(days=days_back)).strftime("%Y%m%d-%H:%M:%S")
            bars = await asyncio.wait_for(
                ib.reqHistoricalDataAsync(contract, end, "1 D", "1 min", "TRADES", False), timeout=90
            )
            rows.append({"symbol": contract.localSymbol or contract.symbol, "days_back": days_back, "bars": len(bars)})
    return rows


async def probe_option_batch(ib: Any, args: argparse.Namespace) -> dict[str, Any]:
    from ib_async import Option, Stock

    stocks = await _qualified(ib, Stock(args.option_symbol, "SMART", "USD"))
    if not stocks:
        return {"symbol": args.option_symbol, "error": "could not qualify"}
    stock = stocks[0]
    [spot_ticker] = await ib.reqTickersAsync(stock)
    spot = spot_ticker.marketPrice()
    if not _finite(spot):
        spot = spot_ticker.close
    chains = await ib.reqSecDefOptParamsAsync(stock.symbol, "", stock.secType, stock.conId)
    chain = next((c for c in chains if c.exchange == "SMART"), None)
    if chain is None or not _finite(spot):
        return {"symbol": stock.symbol, "error": "no SMART option chain or no spot price"}
    expirations = pick_expirations(list(chain.expirations), date.today())
    strikes = pick_call_strikes(list(chain.strikes), spot)
    candidates = [
        Option(stock.symbol, e, s, "C", "SMART", currency="USD", tradingClass=chain.tradingClass)
        for e in expirations
        for s in strikes
    ]
    options = await _qualified(ib, *candidates) if candidates else []
    started = time.monotonic()
    tickers = [ib.reqMktData(o) for o in options]
    while time.monotonic() - started < args.option_timeout and not all(t.modelGreeks for t in tickers):
        await asyncio.sleep(0.25)
    elapsed = time.monotonic() - started
    for option in options:
        ib.cancelMktData(option)
    deltas = [t.modelGreeks.delta for t in tickers if t.modelGreeks and _finite(t.modelGreeks.delta)]
    return {
        "symbol": stock.symbol,
        "expirations": expirations,
        "contracts": len(options),
        "with_greeks": sum(1 for t in tickers if t.modelGreeks),
        "seconds": round(elapsed, 1),
        "delta_range": [round(min(deltas), 2), round(max(deltas), 2)] if deltas else None,
        "data_types": sorted({market_data_type_label(t.marketDataType) for t in tickers}),
    }


async def run_probe(args: argparse.Namespace) -> dict[str, Any]:
    from ib_async import IB
    from ib_async.ib import StartupFetchNONE

    ib = IB()
    errors: list[dict[str, Any]] = []

    def on_error(req_id: int, code: int, message: str, contract: Any) -> None:
        errors.append({"code": code, "symbol": getattr(contract, "symbol", None), "message": redact(message)[:160]})

    ib.errorEvent += on_error
    await ib.connectAsync(args.host, args.port, clientId=args.client_id, timeout=15, readonly=True, fetchFields=StartupFetchNONE)
    report: dict[str, Any] = {"probed_at_utc": datetime.now(UTC).isoformat(timespec="seconds")}
    try:
        accounts = ib.managedAccounts()
        report["server_version"] = ib.client.serverVersion()
        report["accounts"] = [mask_account(a) for a in accounts]
        report["paper"] = bool(accounts) and all(a.startswith("DU") for a in accounts)
        server_time = await ib.reqCurrentTimeAsync()
        report["clock_skew_s"] = round((datetime.now(UTC) - server_time).total_seconds(), 1)
        ib.reqMarketDataType(1)
        sections = {
            "streams": probe_streams(ib, args),
            "iv_history": probe_iv_history(ib, args.iv_symbol),
            "minute_history": probe_minute_history(ib, args),
            "option_batch": probe_option_batch(ib, args),
        }
        for name, coroutine in sections.items():
            try:
                report[name] = await coroutine
            except Exception as exc:  # noqa: BLE001 - report every section that works, even if one fails
                report[name] = {"error": redact(f"{type(exc).__name__}: {exc}")[:200]}
        report["news_providers"] = sorted(p.code for p in await ib.reqNewsProvidersAsync())
    finally:
        report["errors"] = errors
        ib.disconnect()
    return report


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read-only IBKR probe for the Family Desk spike.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4002, help="4002 = IB Gateway paper, 4001 = live, 7497 = TWS paper")
    parser.add_argument("--client-id", type=int, default=901)
    parser.add_argument("--seconds", type=float, default=20.0, help="how long to watch the live streams")
    parser.add_argument("--stocks", type=lambda s: s.split(","), default=["SPY", "NVDA", "AAPL"])
    parser.add_argument("--futures", type=lambda s: s.split(","), default=["ES:CME", "NQ:CME", "MES:CME", "CL:NYMEX", "GC:COMEX"])
    parser.add_argument("--iv-symbol", default="AAPL")
    parser.add_argument("--option-symbol", default="AAPL")
    parser.add_argument("--option-timeout", type=float, default=30.0)
    parser.add_argument("--out", help="also write the report here; keep it under ai-trading/temp/, which is gitignored")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    text = json.dumps(asyncio.run(run_probe(args)), indent=2, default=str)
    print(text)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
