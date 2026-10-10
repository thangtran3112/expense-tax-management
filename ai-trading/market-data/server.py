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
            except Exception as e:  # never drop the connection: FDClient must see a status
                return self._send(500, {"error": f"internal error: {type(e).__name__}"})
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
