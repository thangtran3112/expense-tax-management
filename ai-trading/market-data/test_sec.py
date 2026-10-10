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

    def test_class_shares_use_sec_dash_form(self):
        r = routes()
        r["https://www.sec.gov/files/company_tickers.json"] = (200, {"0": {"cik_str": 1067983, "ticker": "BRK-B", "title": "Berkshire"}})
        r["https://data.sec.gov/api/xbrl/companyfacts/CIK0001067983.json"] = (200, {"facts": {"x": 1}})
        sec, _ = self.make(r)
        self.assertEqual(sec.companyfacts("BRK.B"), {"facts": {"x": 1}})

    def test_invalid_json_is_provider_error(self):
        sec = SecFundamentals("ua", fetch=lambda url, headers: (200, b"not json"), sleep=lambda s: None)
        with self.assertRaises(ProviderError):
            sec.companyfacts("AAPL")


if __name__ == "__main__":
    unittest.main()
