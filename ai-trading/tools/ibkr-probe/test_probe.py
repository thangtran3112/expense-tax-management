from datetime import date

import probe


def test_mask_account_keeps_only_the_letter_prefix():
    assert probe.mask_account("DU1234567") == "DU*******"
    assert probe.mask_account("U7654321") == "U*******"


def test_redact_masks_account_ids_inside_messages():
    message = "Order rejected for account DU1234567 and U7654321."
    assert probe.redact(message) == "Order rejected for account DU******* and U*******."


def test_market_data_type_label():
    assert probe.market_data_type_label(1) == "live"
    assert probe.market_data_type_label(3) == "delayed"
    assert probe.market_data_type_label(None) == "none"


def test_summarize_intervals():
    assert probe.summarize_intervals([0.0, 0.25, 0.5, 0.75, 1.75]) == {"updates": 5, "median_ms": 250, "p90_ms": 1000}
    assert probe.summarize_intervals([1.0]) == {"updates": 1, "median_ms": None, "p90_ms": None}


def test_pick_expirations_keeps_21_to_45_days_nearest_first():
    expirations = ["20261016", "20261106", "20261120", "20261218", "20270115"]
    assert probe.pick_expirations(expirations, date(2026, 10, 12)) == ["20261106", "20261120"]


def test_pick_call_strikes_are_out_of_the_money_within_10_percent():
    strikes = [180.0, 185.0, 190.0, 195.0, 200.0, 205.0, 210.0, 215.0]
    assert probe.pick_call_strikes(strikes, spot=189.0) == [190.0, 195.0, 200.0, 205.0]
