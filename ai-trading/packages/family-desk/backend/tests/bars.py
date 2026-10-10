"""Synthetic bars for tests. All prices and volumes are made up."""

from datetime import date

import pandas as pd

from ai_trading.core.calendar import Asset, et, previous_session, session


def trading_days(asset: Asset, last: date, count: int) -> list[date]:
    """The `count` trading days ending with `last` (a trading day), oldest first."""
    days = [last]
    while len(days) < count:
        days.append(previous_session(asset, days[-1]))
    return days[::-1]


def minute_bars(asset: Asset, day: date, price: float = 100.0, volume: int = 1_000) -> pd.DataFrame:
    """Flat 1-minute bars covering `day`'s whole extended session."""
    found = session(asset, day)
    index = pd.date_range(found.extended_open, found.extended_close, freq="1min", inclusive="left")
    return pd.DataFrame(
        {"open": price, "high": price, "low": price, "close": price, "volume": volume},
        index=index,
        dtype=float,
    )


def set_bar(bars: pd.DataFrame, day: date, hhmm: str, **values: float) -> None:
    """Overwrites columns of the bar starting at HH:MM ET on `day`. close= also moves high/low."""
    at = et(day, hhmm)
    for column, value in values.items():
        bars.loc[at, column] = value
    if "close" in values:
        bars.loc[at, "high"] = max(bars.loc[at, "high"], values["close"])
        bars.loc[at, "low"] = min(bars.loc[at, "low"], values["close"])


def daily_bars(days: list[date], closes: list[float], volume: float = 1_000_000) -> pd.DataFrame:
    """Daily bars with open = high = low = close unless changed afterwards."""
    return pd.DataFrame(
        {"open": closes, "high": closes, "low": closes, "close": closes, "volume": volume},
        index=pd.Index(days),
        dtype=float,
    )
