from datetime import date

import pandas as pd

from ai_trading.core.calendar import annotate, et, previous_session, session


def utc(text: str) -> pd.Timestamp:
    return pd.Timestamp(text, tz="UTC")


def test_regular_open_follows_daylight_saving():
    assert session("stock", date(2026, 3, 6)).regular_open == utc("2026-03-06 14:30")
    assert session("stock", date(2026, 3, 9)).regular_open == utc("2026-03-09 13:30")
    assert session("stock", date(2026, 10, 30)).regular_open == utc("2026-10-30 13:30")
    assert session("stock", date(2026, 11, 2)).regular_open == utc("2026-11-02 14:30")


def test_half_day_closes_at_1300_and_post_market_follows():
    found = session("stock", date(2026, 11, 27))
    assert found.regular_close == utc("2026-11-27 18:00")
    assert found.extended_close == utc("2026-11-27 22:00")


def test_holidays():
    assert session("stock", date(2026, 11, 26)) is None  # Thanksgiving
    assert session("stock", date(2026, 4, 3)) is None  # Good Friday
    assert session("future", date(2026, 4, 3)) is None
    thanksgiving = session("future", date(2026, 11, 26))  # CME trades, closes early
    assert thanksgiving.regular_close == et(date(2026, 11, 26), "13:00")


def test_futures_week_opens_sunday_1800_et():
    monday = session("future", date(2026, 3, 9))  # the Sunday before is the DST change
    assert monday.extended_open == et(date(2026, 3, 8), "18:00")
    assert monday.extended_open == utc("2026-03-08 22:00")
    assert monday.extended_close == et(date(2026, 3, 9), "17:00")


def test_previous_session_skips_weekends_and_holidays():
    assert previous_session("stock", date(2026, 3, 9)) == date(2026, 3, 6)
    assert previous_session("stock", date(2026, 11, 27)) == date(2026, 11, 25)
    assert previous_session("future", date(2026, 11, 27)) == date(2026, 11, 26)


def _flat(start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
    index = pd.date_range(start, end, freq="1min", inclusive="left")
    return pd.DataFrame({"open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0}, index=index)


def test_annotate_futures_session_from_sunday_evening():
    bars = _flat(et(date(2026, 3, 8), "17:58"), et(date(2026, 3, 9), "17:02"))
    ann = annotate(bars, "future")
    counts = ann.groupby("phase").size().to_dict()
    assert counts == {"pre": 930, "regular": 390, "post": 60}
    assert set(ann["day"]) == {date(2026, 3, 9)}
    assert ann.index[0] == et(date(2026, 3, 8), "18:00")


def test_annotate_stock_half_day_and_drops_closed_days():
    bars = pd.concat(
        [
            _flat(et(date(2026, 11, 26), "09:30"), et(date(2026, 11, 26), "16:00")),  # holiday
            _flat(et(date(2026, 11, 27), "04:00"), et(date(2026, 11, 27), "20:00")),
        ]
    )
    counts = annotate(bars, "stock").groupby("phase").size().to_dict()
    assert counts == {"pre": 330, "regular": 210, "post": 240}
