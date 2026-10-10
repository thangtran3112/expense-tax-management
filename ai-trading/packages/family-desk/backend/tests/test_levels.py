from datetime import date

import numpy as np
import pandas as pd
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.core import levels
from ai_trading.core.calendar import annotate, et


def test_prior_day_skips_the_holiday_and_never_substitutes():
    daily = daily_bars([date(2026, 11, 24), date(2026, 11, 25)], [101.0, 102.0])
    days = pd.Index([date(2026, 11, 27), date(2026, 11, 25)])
    out = levels.prior_day(daily, days, "stock", "close")
    assert out[date(2026, 11, 27)] == 102.0  # Thanksgiving skipped
    assert out[date(2026, 11, 25)] == 101.0
    missing = levels.prior_day(daily.drop(date(2026, 11, 25)), pd.Index([date(2026, 11, 27)]), "stock", "close")
    assert np.isnan(missing.iloc[0])  # no older bar stands in for the missing day


def test_n_day_high_excludes_the_day_itself():
    days = trading_days("stock", date(2026, 10, 6), 25)
    daily = daily_bars(days, [float(n) for n in range(1, 26)])
    out = levels.n_day(daily, pd.Index([days[-1], date(2026, 10, 7), days[5]]), 20, "high")
    assert out.iloc[0] == 24.0  # the 20 days before the last one
    assert out.iloc[1] == 25.0  # a day without its own bar yet (intraday)
    assert np.isnan(out.iloc[2])  # not enough history


def test_premarket_levels_are_known_from_the_open():
    day = date(2026, 10, 6)
    bars = minute_bars("stock", day)
    set_bar(bars, day, "08:00", high=105.0)
    set_bar(bars, day, "06:00", low=95.0)
    ann = annotate(bars, "stock")
    high, low = levels.pre_phase(ann, "high"), levels.pre_phase(ann, "low")
    assert np.isnan(high.loc[et(day, "09:29")])
    assert high.loc[et(day, "09:30")] == 105.0
    assert low.loc[et(day, "15:00")] == 95.0


def test_futures_overnight_levels_start_sunday_evening():
    day = date(2026, 10, 5)  # Monday
    bars = minute_bars("future", day, price=5000.0)
    set_bar(bars, date(2026, 10, 4), "18:30", high=5010.0)
    high = levels.pre_phase(annotate(bars, "future"), "high")
    assert high.loc[et(day, "09:30")] == 5010.0


def test_opening_range_is_known_once_its_window_closes():
    day = date(2026, 10, 6)
    bars = minute_bars("stock", day)
    set_bar(bars, day, "09:44", high=101.0)
    set_bar(bars, day, "09:45", high=150.0)  # after the window
    out = levels.opening_range(annotate(bars, "stock"), "stock", 15, "high")
    assert np.isnan(out.loc[et(day, "09:44")])
    assert out.loc[et(day, "09:45")] == 101.0
    assert out.loc[et(day, "15:59")] == 101.0


def test_opening_range_longer_than_a_half_day_never_forms():
    day = date(2026, 11, 27)
    out = levels.opening_range(annotate(minute_bars("stock", day), "stock"), "stock", 220, "high")
    assert out.isna().all()
