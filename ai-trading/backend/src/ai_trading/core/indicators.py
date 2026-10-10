"""Indicators over bar series. Every value uses only its own and earlier bars."""

import numpy as np
import pandas as pd

from ai_trading.core.calendar import ET


def sma(values: pd.Series, length: int) -> pd.Series:
    return values.rolling(length, min_periods=length).mean()


def ema(values: pd.Series, length: int) -> pd.Series:
    return values.ewm(span=length, adjust=False, min_periods=length).mean()


def _wilder(values: pd.Series, length: int) -> pd.Series:
    """Wilder's smoothing, seeded by the mean of the first `length` valid values:
    avg_t = (avg_{t-1} * (length - 1) + x_t) / length for every later value."""
    valid = np.flatnonzero(values.notna().to_numpy())
    if len(valid) < length:
        return pd.Series(np.nan, index=values.index)
    seed_at = valid[length - 1]
    seeded = values.copy()
    seeded.iloc[:seed_at] = np.nan
    seeded.iloc[seed_at] = values.iloc[valid[:length]].mean()
    return seeded.ewm(alpha=1 / length, adjust=False).mean()


def rsi(close: pd.Series, length: int) -> pd.Series:
    """Wilder's RSI. 100 when there were no losses, 0 when there were no gains."""
    delta = close.diff()
    gain = _wilder(delta.clip(lower=0), length)
    loss = _wilder(-delta.clip(upper=0), length)
    with np.errstate(divide="ignore", invalid="ignore"):
        out = 100 - 100 / (1 + gain / loss)
    return out.where(~((gain == 0) & (loss == 0)), 50.0)


def atr(bars: pd.DataFrame, length: int) -> pd.Series:
    """Wilder's average true range."""
    prev_close = bars["close"].shift(1)
    true_range = pd.concat(
        [
            bars["high"] - bars["low"],
            (bars["high"] - prev_close).abs(),
            (bars["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return _wilder(true_range, length)


def session_vwap(ann: pd.DataFrame) -> pd.Series:
    """VWAP of each day's regular session; NaN outside regular hours. `ann` comes from annotate()."""
    regular = ann[ann["phase"] == "regular"]
    typical = (regular["high"] + regular["low"] + regular["close"]) / 3
    weighted = (typical * regular["volume"]).groupby(regular["day"]).cumsum()
    volume = regular["volume"].groupby(regular["day"]).cumsum()
    return (weighted / volume.replace(0, np.nan)).reindex(ann.index)


def rvol_intraday(ann: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Volume so far in this day's phase, over its average at the same clock time on the
    previous `lookback_days` days that have data. NaN until that much history exists."""
    cumulative = ann["volume"].groupby([ann["day"], ann["phase"]]).cumsum()
    key = pd.MultiIndex.from_arrays([ann["phase"], ann.index.tz_convert(ET).strftime("%H:%M")])
    table = (
        pd.Series(
            cumulative.to_numpy(),
            index=pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)]),
        )
        .unstack([1, 2])
        .sort_index()
    )
    table = table.T.groupby(level=0).ffill().T
    baseline = table.shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    lookup = baseline.stack([0, 1], future_stack=True)
    rows = pd.MultiIndex.from_arrays([ann["day"], key.get_level_values(0), key.get_level_values(1)])
    expected = lookup.reindex(rows).to_numpy()
    with np.errstate(divide="ignore", invalid="ignore"):
        out = cumulative.to_numpy() / np.where(expected > 0, expected, np.nan)
    return pd.Series(out, index=ann.index)


def rvol_daily(daily: pd.DataFrame, lookback_days: int) -> pd.Series:
    """Each day's volume over the average of the previous `lookback_days` days."""
    expected = daily["volume"].shift(1).rolling(lookback_days, min_periods=lookback_days).mean()
    return daily["volume"] / expected.replace(0, np.nan)
