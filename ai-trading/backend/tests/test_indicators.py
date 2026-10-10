from datetime import date

import numpy as np
import pandas as pd
import pytest
from bars import minute_bars, set_bar, trading_days

from ai_trading.core import indicators
from ai_trading.core.calendar import annotate, et


def series(*values: float) -> pd.Series:
    return pd.Series(values, dtype=float)


def test_sma_and_ema():
    np.testing.assert_allclose(indicators.sma(series(1, 2, 3, 4, 5), 3), [np.nan, np.nan, 2, 3, 4])
    # span 3 -> alpha 0.5, seeded with the first value: 1, 1.5, 2.25, 3.125, 4.0625
    np.testing.assert_allclose(indicators.ema(series(1, 2, 3, 4, 5), 3), [np.nan, np.nan, 2.25, 3.125, 4.0625])


def test_rsi_wilder_values_and_extremes():
    # deltas +1 -1 +1 with length 2: average gain 0.5 then 0.75, loss 0.5 then 0.25
    np.testing.assert_allclose(indicators.rsi(series(1, 2, 1, 2), 2), [np.nan, np.nan, 50, 75])
    assert indicators.rsi(series(*range(1, 20)), 14).iloc[-1] == 100
    assert indicators.rsi(series(*range(20, 1, -1)), 14).iloc[-1] == 0
    assert indicators.rsi(series(*[5.0] * 20), 14).iloc[-1] == 50


def test_atr_uses_the_previous_close():
    bars = pd.DataFrame({"high": [10.0, 12.0], "low": [9.0, 11.0], "close": [9.5, 11.5]})
    np.testing.assert_allclose(indicators.atr(bars, 1), [1.0, 2.5])


def test_session_vwap_covers_the_regular_session_and_resets_daily():
    days = trading_days("stock", date(2026, 10, 6), 2)
    bars = pd.concat([minute_bars("stock", day) for day in days])
    set_bar(bars, days[1], "09:30", high=110.0, low=90.0, close=100.0, volume=1000.0)
    set_bar(bars, days[1], "09:31", high=106.0, low=100.0, close=103.0, volume=3000.0)
    vwap = indicators.session_vwap(annotate(bars, "stock"))
    assert np.isnan(vwap.loc[et(days[1], "09:29")])  # pre-market
    assert vwap.loc[et(days[1], "09:30")] == 100.0
    assert vwap.loc[et(days[1], "09:31")] == pytest.approx((100 * 1000 + 103 * 3000) / 4000)
    assert vwap.loc[et(days[0], "15:59")] == 100.0  # yesterday's own session


def test_intraday_rvol_compares_the_same_clock_time():
    days = trading_days("stock", date(2026, 10, 6), 3)
    bars = pd.concat(
        [minute_bars("stock", days[0]), minute_bars("stock", days[1]), minute_bars("stock", days[2], volume=3000)]
    )
    bars = bars.drop(et(days[2], "10:01"))  # a minute without trades keeps the running total
    rvol = indicators.rvol_intraday(annotate(bars, "stock"), 2)
    assert rvol.loc[et(days[2], "10:00")] == pytest.approx(3.0)
    assert rvol.loc[et(days[2], "10:02")] == pytest.approx((32 * 3000) / (33 * 1000))  # 33 bars, one missing
    assert rvol.loc[et(days[2], "05:00")] == pytest.approx(3.0)  # pre-market compares with pre-market
    assert np.isnan(rvol.loc[et(days[1], "10:00")])  # only one earlier day


def test_daily_rvol():
    daily = pd.DataFrame({"volume": [100.0, 100.0, 300.0]})
    np.testing.assert_allclose(indicators.rvol_daily(daily, 2), [np.nan, np.nan, 3.0])
