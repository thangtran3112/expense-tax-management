import json

import flex_probe

SEND_OK = (
    "<FlexStatementResponse><Status>Success</Status><ReferenceCode>1234567890</ReferenceCode>"
    "<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>"
    "</FlexStatementResponse>"
)
IN_PROGRESS = (
    "<FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode>"
    "<ErrorMessage>Statement generation in progress. Please try again shortly.</ErrorMessage>"
    "</FlexStatementResponse>"
)
STATEMENT = (
    '<FlexQueryResponse queryName="desk-holdings" type="AF"><FlexStatements count="1">'
    '<FlexStatement accountId="U7654321" fromDate="20261009" toDate="20261009"><OpenPositions>'
    '<OpenPosition accountId="U7654321" symbol="AAPL" assetCategory="STK" position="100" '
    'costBasisPrice="150.25" levelOfDetail="LOT" openDateTime="20240105;101500"/>'
    '<OpenPosition accountId="U7654321" symbol="AAPL  261120C00260000" assetCategory="OPT" '
    'position="-1" strike="260" expiry="20261120" putCall="C" levelOfDetail="SUMMARY"/>'
    "</OpenPositions><Trades/></FlexStatement></FlexStatements></FlexQueryResponse>"
)


def test_parse_response_reads_reference_and_url():
    sent = flex_probe.parse_response(SEND_OK)
    assert sent["status"] == "Success"
    assert sent["reference"] == "1234567890"
    assert sent["url"].endswith("/GetStatement")


def test_parse_response_reads_the_in_progress_code():
    assert flex_probe.parse_response(IN_PROGRESS)["error_code"] == "1019"


def test_summary_reports_counts_and_field_names_never_values():
    summary = flex_probe.summarize_statements(STATEMENT)
    detail = summary["detail"][0]
    positions = detail["sections"]["OpenPositions"]
    assert summary["statements"] == 1
    assert detail["account"] == "U*******"
    assert positions["records"] == 2
    assert positions["level_of_detail"] == {"LOT": 1, "SUMMARY": 1}
    assert positions["asset_category"] == {"STK": 1, "OPT": 1}
    assert "costBasisPrice" in positions["fields"]
    assert detail["sections"]["Trades"] == {"records": 0, "fields": []}
    text = json.dumps(summary)
    for value in ("7654321", "150.25", "AAPL", "20240105"):
        assert value not in text
