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
        with e:
            return e.code, json.loads(e.read())


class ServerTest(unittest.TestCase):
    def start(self, prices=None, fundamentals=None):
        srv = server.make_server(0, TOKEN, prices or FakePrices(), fundamentals or FakeFundamentals())
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
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
        ctx.exception.close()
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
