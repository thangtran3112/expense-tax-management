# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Read-only IBKR Flex Web Service probe for the Family Desk verification spike (02a section 12).

Proves that a Flex token and an Activity Flex query return what the holdings import needs.
It prints only section names, record counts, field names, and the levelOfDetail and
assetCategory mix; never values. The token and query ID come from the environment:

  common/config/family_config.py run ai-trading/desk -- uv run ai-trading/tools/ibkr-probe/flex_probe.py
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from typing import Any

from probe import mask_account

BASE_URL = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService"
USER_AGENT = "family-desk-flex-probe/1.0"
IN_PROGRESS = "1019"  # statement generation in progress; retry


def parse_response(xml_text: str) -> dict[str, str | None]:
    root = ET.fromstring(xml_text)
    tags = {"status": "Status", "reference": "ReferenceCode", "url": "Url", "error_code": "ErrorCode", "error": "ErrorMessage"}
    return {name: root.findtext(tag) for name, tag in tags.items()}


def summarize_statements(xml_text: str) -> dict[str, Any]:
    """Counts and field names per section, plus the lot and asset mix of open positions. No values."""
    statements = ET.fromstring(xml_text).findall(".//FlexStatement")
    detail = []
    for statement in statements:
        sections: dict[str, Any] = {}
        for section in statement:
            records = list(section)
            entry: dict[str, Any] = {"records": len(records), "fields": sorted({k for r in records for k in r.attrib})}
            if section.tag == "OpenPositions":
                entry["level_of_detail"] = dict(Counter(r.get("levelOfDetail", "") for r in records))
                entry["asset_category"] = dict(Counter(r.get("assetCategory", "") for r in records))
            sections[section.tag] = entry
        detail.append({"account": mask_account(statement.get("accountId", "")), "sections": sections})
    return {"statements": len(statements), "detail": detail}


def fetch(url: str, params: dict[str, str]) -> str:
    request = urllib.request.Request(f"{url}?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode("utf-8")


def main() -> int:
    token, query_id = os.environ.get("IBKR_FLEX_TOKEN"), os.environ.get("IBKR_FLEX_QUERY_ID")
    if not token or not query_id:
        print("Set IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID (run through family_config.py run ai-trading/desk).", file=sys.stderr)
        return 2

    def report(step: str, status: dict[str, str | None]) -> int:
        safe = {k: (v or "").replace(token, "***") for k, v in status.items() if k in ("status", "error_code", "error")}
        print(json.dumps({"step": step, **safe}))
        return 1

    sent = parse_response(fetch(f"{BASE_URL}/SendRequest", {"t": token, "q": query_id, "v": "3"}))
    if sent["status"] != "Success" or not sent["reference"]:
        return report("SendRequest", sent)
    for attempt in range(10):
        time.sleep(5 * (attempt + 1))
        body = fetch(sent["url"] or f"{BASE_URL}/GetStatement", {"t": token, "q": sent["reference"], "v": "3"})
        if "<FlexQueryResponse" in body:
            print(json.dumps(summarize_statements(body), indent=2))
            return 0
        status = parse_response(body)
        if status["error_code"] != IN_PROGRESS:
            return report("GetStatement", status)
    print(json.dumps({"step": "GetStatement", "error": "statement still generating after 10 tries"}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
