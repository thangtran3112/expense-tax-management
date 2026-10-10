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
