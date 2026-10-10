from datetime import date
from typing import Any

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import et
from ai_trading.core.evaluate import check, evaluate

DAY = date(2026, 10, 6)
CLOSE = {"series": "close"}


def make_spec(when: dict[str, Any], run_on: str = "bar_close_1m", session: str = "regular") -> StrategySpecV1:
    return StrategySpecV1.model_validate(
        {
            "schemaVersion": 1,
            "name": "Test",
            "watch": {"universe": {"symbols": ["TEST"]}, "session": session, "runOn": run_on},
            "when": when,
            "then": {"alert": {"channels": ["inbox"]}},
        }
    )


def above(value: float, op: str = "gt") -> dict[str, Any]:
    return {"op": op, "left": CLOSE, "right": {"value": value}}


def times(candidates) -> list[str]:
    return [c.bar_time.tz_convert("America/New_York").strftime("%m-%d %H:%M") for c in candidates]


def run(spec, bars, daily=None, as_of=None, asset="stock"):
    daily = daily if daily is not None else daily_bars([], [])
    return evaluate(spec, "TEST", asset, bars_1m=bars, bars_1d=daily, as_of=as_of or et(DAY, "20:00"))


def closes(bars, day, start: str, end: str, value: float) -> None:
    for at in pd.date_range(et(day, start), et(day, end), freq="1min", inclusive="left"):
        bars.loc[at, ["open", "high", "low", "close"]] = value


def test_crosses_fires_once_on_the_crossing_bar():
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:00", "16:00", 101.0)
    assert times(run(make_spec(above(100.5, "crosses_above")), bars)) == ["10-06 10:00"]


def test_a_level_on_the_left_crosses_like_on_the_right():
    # Close crosses the opening-range high on the bar the range itself first becomes known
    # (09:45): the level has no earlier known value either, so a left-side fallback is required.
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "09:35", high=101.0)
    set_bar(bars, DAY, "09:45", close=101.5)
    orb_high = {"level": "opening_range_high", "minutes": 15}
    below = make_spec({"op": "crosses_below", "left": orb_high, "right": CLOSE})
    above_the_orb = make_spec({"op": "crosses_above", "left": CLOSE, "right": orb_high})
    assert times(run(below, bars)) == ["10-06 09:45"]
    assert times(run(above_the_orb, bars)) == ["10-06 09:45"]


def test_a_rule_that_stays_true_fires_on_each_rising_edge():
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:00", "10:10", 101.0)
    closes(bars, DAY, "10:20", "10:30", 101.0)
    assert times(run(make_spec(above(100.5)), bars)) == ["10-06 10:00", "10-06 10:20"]


def test_the_edge_resets_each_trading_day():
    days = trading_days("stock", DAY, 2)
    bars = pd.concat([minute_bars("stock", day, price=101.0) for day in days])
    assert times(run(make_spec(above(100.5)), bars)) == ["10-05 09:30", "10-06 09:30"]


def test_a_bar_counts_only_once_its_minute_has_ended():
    bars = minute_bars("stock", DAY)
    in_progress = bars.copy()
    set_bar(in_progress, DAY, "10:00", close=105.0)  # true mid-bar...
    spec = make_spec(above(104.0))
    assert run(spec, in_progress, as_of=et(DAY, "10:00") + pd.Timedelta(seconds=30)) == []
    assert run(spec, bars, as_of=et(DAY, "10:01")) == []  # ...false at the close: never fires
    assert times(run(spec, in_progress, as_of=et(DAY, "10:01"))) == ["10-06 10:00"]


def test_missing_data_is_unknown_even_under_not():
    bars = minute_bars("stock", DAY)
    spec = make_spec({"not": {"op": "gt", "left": CLOSE, "right": {"series": "vwap"}}}, session="extended")
    assert times(run(spec, bars))[0] == "10-06 09:30"  # no VWAP before the open


def test_evidence_holds_only_known_values():
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "05:00", "16:00", 101.0)
    when = {"any": [above(100.5), {"op": "gt", "left": {"series": "vwap"}, "right": {"value": 100}}]}
    found = run(make_spec(when, session="extended"), bars)
    assert times(found)[0] == "10-06 05:00"
    assert found[0].evidence == {"close": 101.0}


def test_time_between_can_wrap_past_midnight():
    bars = minute_bars("future", DAY, price=5000.0)
    spec = make_spec({"all": [{"op": "time_between", "start": "18:00", "end": "02:00"}, above(0)]}, session="extended")
    assert times(run(spec, bars, asset="future")) == ["10-05 18:00"]


def test_within_pct_is_inclusive():
    bars = minute_bars("stock", DAY, price=98.0)
    set_bar(bars, DAY, "10:00", close=101.0)  # exactly 1% away
    set_bar(bars, DAY, "11:00", close=101.01)
    near = make_spec({"op": "within_pct", "left": CLOSE, "right": {"value": 100}, "pct": 1})
    assert times(run(near, bars)) == ["10-06 10:00"]


@pytest.mark.parametrize(
    ("when", "run_on", "message"),
    [
        ({"op": "gt", "left": CLOSE, "right": {"series": "vwap"}}, "daily_close", "vwap needs intraday bars"),
        (
            {"op": "gt", "left": CLOSE, "right": {"level": "opening_range_high", "minutes": 5}},
            "premarket_0830",
            "opening_range_high is not known at 08:30 ET",
        ),
        ({"op": "time_between", "start": "09:30", "end": "10:00"}, "weekly", "time_between needs intraday bars"),
    ],
)
def test_check_rejects_operands_the_cadence_cannot_compute(when, run_on, message):
    spec = make_spec(when, run_on=run_on)
    assert message in "; ".join(check(spec))
    with pytest.raises(ValueError, match=message):
        evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily_bars([], []), as_of=et(DAY, "20:00"))


def test_daily_points_are_regular_closes_including_half_days():
    daily = daily_bars([date(2026, 11, 25), date(2026, 11, 27)], [1.0, 3.0])
    spec = make_spec(above(2), run_on="daily_close")
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily, as_of=et(date(2026, 11, 27), "20:00"))
    assert [c.bar_time for c in found] == [pd.Timestamp("2026-11-27 18:00", tz="UTC")]
    early = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily, as_of=et(date(2026, 11, 27), "12:59"))
    assert early == []  # the half day's bar is not closed yet


def test_weekly_reads_the_last_trading_day_of_a_finished_week():
    days = [date(2026, 3, 30), date(2026, 3, 31), date(2026, 4, 1), date(2026, 4, 2), date(2026, 4, 6)]
    daily = daily_bars(days, [1.0] * len(days))
    spec = make_spec(above(0), run_on="weekly")
    found = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily, as_of=et(date(2026, 4, 6), "20:00"))
    assert times(found) == ["04-02 16:00"]  # Good Friday closed: Thursday ends the week
    midweek = evaluate(spec, "TEST", "stock", bars_1m=None, bars_1d=daily, as_of=et(date(2026, 4, 1), "20:00"))
    assert midweek == []


def test_unknown_data_does_not_reset_the_edge():
    bars = minute_bars("stock", DAY)
    closes(bars, DAY, "10:00", "16:00", 101.0)
    bars.loc[et(DAY, "10:01"), "close"] = float("nan")
    assert times(run(make_spec(above(100.5)), bars)) == ["10-06 10:00"]


def test_a_series_first_value_is_not_a_crossing():
    bars = minute_bars("stock", DAY, price=99.0)
    closes(bars, DAY, "04:02", "09:30", 101.0)
    when = {"op": "crosses_above", "left": CLOSE, "right": {"series": "sma", "length": 3}}
    spec = make_spec(when, session="extended")
    assert "10-06 04:02" not in times(run(spec, bars))


def test_premarket_scan_reads_the_bars_closed_by_0830():
    days = trading_days("stock", DAY, 2)
    daily = daily_bars(days[:1], [100.0])
    spec = make_spec({"op": "gte", "left": {"series": "gap_pct"}, "right": {"value": 3}}, run_on="premarket_0830")
    bars = minute_bars("stock", DAY)
    set_bar(bars, DAY, "08:29", close=104.0)
    found = run(spec, bars, daily)
    assert times(found) == ["10-06 08:30"] and found[0].evidence == {"gap_pct": 4.0}
    assert run(spec, bars, daily, as_of=et(DAY, "08:29:59")) == []
    late = minute_bars("stock", DAY)
    set_bar(late, DAY, "08:30", close=104.0)  # closes at 08:31, after the scan
    assert run(spec, late, daily) == []
