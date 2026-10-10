import unittest

import metrics


def dur(start, end, val, filed, form="10-Q"):
    return {"start": start, "end": end, "val": val, "filed": filed, "form": form}


def inst(end, val, filed, form="10-Q"):
    return {"end": end, "val": val, "filed": filed, "form": form}


def company(revenue_q4_restated=None):
    rev = [
        dur("2023-01-01", "2023-03-31", 100, "2023-05-01"),
        dur("2023-04-01", "2023-06-30", 110, "2023-08-01"),
        dur("2023-07-01", "2023-09-30", 120, "2023-11-01"),
        dur("2023-01-01", "2023-12-31", 460, "2024-02-15", "10-K"),   # Q4 derived: 130
        dur("2024-01-01", "2024-03-31", 140, "2024-05-01"),
        dur("2023-01-01", "2023-06-30", 210, "2023-08-01"),           # YTD six months: ignored
    ]
    ni = [dur(r["start"], r["end"], r["val"] // 10, r["filed"], r["form"]) for r in rev]
    eps = [dur(r["start"], r["end"], r["val"] / 100, r["filed"], r["form"]) for r in rev]
    if revenue_q4_restated:   # revenue only, so the restated net margin differs
        rev.append(dur("2023-01-01", "2023-12-31", revenue_q4_restated, "2024-06-01", "10-K/A"))
    equity = [inst("2023-12-31", 500, "2024-02-15", "10-K"), inst("2024-03-31", 520, "2024-05-01")]
    return {
        "facts": {
            "us-gaap": {
                "Revenues": {"units": {"USD": rev}},
                "NetIncomeLoss": {"units": {"USD": ni}},
                "EarningsPerShareDiluted": {"units": {"USD/shares": eps}},
                "StockholdersEquity": {"units": {"USD": equity}},
                "AssetsCurrent": {"units": {"USD": [inst("2024-03-31", 300, "2024-05-01")]}},
                "LiabilitiesCurrent": {"units": {"USD": [inst("2024-03-31", 150, "2024-05-01")]}},
            },
            "dei": {"EntityCommonStockSharesOutstanding": {"units": {"shares": [inst("2024-04-20", 10, "2024-05-01")]}}},
        }
    }


class MetricsTest(unittest.TestCase):
    def test_ttm_uses_four_quarters_with_derived_q4(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 10)
        self.assertEqual([r["report_period"] for r in rows], ["2024-03-31", "2023-12-31"])
        latest = rows[0]
        self.assertEqual(latest["filing_date"], "2024-05-01")
        self.assertAlmostEqual(latest["net_margin"], 50 / 500)
        self.assertAlmostEqual(latest["earnings_per_share"], 1.1 + 1.2 + 1.3 + 1.4)
        self.assertAlmostEqual(latest["current_ratio"], 2.0)
        self.assertAlmostEqual(latest["book_value_per_share"], 52.0)
        self.assertIsNone(latest["revenue_growth"])                      # no TTM four quarters earlier

    def test_point_in_time_hides_later_filings(self):
        rows = metrics.ttm_rows(company(), "2024-04-30", 10)
        self.assertEqual([r["report_period"] for r in rows], ["2023-12-31"])
        self.assertEqual(metrics.ttm_rows(company(), "2023-12-31", 10), [])

    def test_restatement_filed_later_does_not_leak_backward(self):
        before = metrics.ttm_rows(company(revenue_q4_restated=480), "2024-05-01", 10)
        after = metrics.ttm_rows(company(revenue_q4_restated=480), "2024-06-01", 10)
        self.assertAlmostEqual(before[1]["net_margin"], 46 / 460)
        self.assertNotEqual(before[1]["net_margin"], after[1]["net_margin"])

    def test_missing_concepts_leave_ratios_null(self):
        row = metrics.ttm_rows(company(), "2024-05-01", 1)[0]
        self.assertIsNone(row["gross_margin"])
        self.assertIsNone(row["debt_to_equity"])
        self.assertIsNone(row["free_cash_flow_per_share"])

    def test_limit_and_valuation(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 1)
        metrics.add_valuation(rows, metrics.close_lookup([{"time": "2024-04-30T04:00:00Z", "close": 20.0}]))
        self.assertEqual(rows[0]["market_cap"], 200.0)                  # 10 shares x close on/before 2024-05-01
        self.assertAlmostEqual(rows[0]["price_to_earnings_ratio"], 200.0 / rows[0]["_net_income_ttm"])
        public = metrics.public_row("AAPL", rows[0])
        self.assertEqual(public["ticker"], "AAPL")
        self.assertFalse([k for k in public if k.startswith("_")])

    def test_non_positive_income_has_no_pe(self):
        rows = metrics.ttm_rows(company(), "2024-05-01", 1)
        rows[0]["_net_income_ttm"] = -5
        metrics.add_valuation(rows, lambda day: 20.0)
        self.assertIsNone(rows[0]["price_to_earnings_ratio"])

    def test_quarters_derived_from_year_to_date_cash_flow(self):
        cf = company()
        ocf = [dur("2023-01-01", "2023-03-31", 30, "2023-05-01"), dur("2023-01-01", "2023-06-30", 65, "2023-08-01"),
               dur("2023-01-01", "2023-09-30", 100, "2023-11-01"), dur("2023-01-01", "2023-12-31", 140, "2024-02-15", "10-K"),
               dur("2024-01-01", "2024-03-31", 40, "2024-05-01")]
        capex = [dur(r["start"], r["end"], {30: 10, 65: 20, 100: 30, 140: 40, 40: 10}[r["val"]], r["filed"], r["form"]) for r in ocf]
        cf["facts"]["us-gaap"]["NetCashProvidedByUsedInOperatingActivities"] = {"units": {"USD": ocf}}
        cf["facts"]["us-gaap"]["PaymentsToAcquirePropertyPlantAndEquipment"] = {"units": {"USD": capex}}
        row = metrics.ttm_rows(cf, "2024-05-01", 1)[0]
        self.assertAlmostEqual(row["free_cash_flow_per_share"], ((35 + 35 + 40 + 40) - (10 + 10 + 10 + 10)) / 10)


if __name__ == "__main__":
    unittest.main()
