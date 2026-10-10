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
        ticker = ticker.upper().replace(".", "-")  # SEC lists class shares as BRK-B
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
