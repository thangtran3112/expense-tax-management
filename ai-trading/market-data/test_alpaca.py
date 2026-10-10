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

    def test_invalid_json_is_provider_error(self):
        prices = AlpacaPrices("kid", "sec", fetch=lambda url, headers: (200, b"<html>maintenance</html>"), today=lambda: date(2024, 2, 1))
        with self.assertRaises(ProviderError):
            prices.daily_bars("AAPL", "2024-01-01", "2024-01-31", "split")


if __name__ == "__main__":
    unittest.main()
