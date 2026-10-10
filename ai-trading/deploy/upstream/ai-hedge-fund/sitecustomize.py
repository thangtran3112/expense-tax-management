# Repoints upstream's Financial Datasets client at the family market-data
# service (01m) without editing upstream. Loaded by `site` at every start.
import os

_url = os.environ.get("FD_BASE_URL")
if _url:
    import hedge_fund.data.client as _client

    _client.FDClient.BASE_URL = _url.rstrip("/")
