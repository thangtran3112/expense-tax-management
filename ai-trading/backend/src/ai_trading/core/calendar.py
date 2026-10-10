"""Trading sessions for US stocks (XNYS) and CME futures (CMES), in UTC.

Stocks: pre 04:00-09:30 ET, regular 09:30-16:00 ET (13:00 on half days), post until 4 hours
after the regular close. Futures: the Globex session opens 18:00 ET the evening before the
trading day ("pre", the overnight session), "regular" is 09:30-16:00 ET (earlier on CME early
closes), and "post" runs to 17:00 ET, the daily maintenance break.
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from functools import cache
from typing import Literal
from zoneinfo import ZoneInfo

import exchange_calendars as xcals
import numpy as np
import pandas as pd

ET = ZoneInfo("America/New_York")
Asset = Literal["stock", "future"]


@dataclass(frozen=True)
class Session:
    day: date
    extended_open: pd.Timestamp
    regular_open: pd.Timestamp
    regular_close: pd.Timestamp
    extended_close: pd.Timestamp


@cache
def _calendar(asset: Asset) -> xcals.ExchangeCalendar:
    return xcals.get_calendar("XNYS" if asset == "stock" else "CMES")


def et(day: date, hhmm: str) -> pd.Timestamp:
    """The UTC instant of HH:MM America/New_York on `day`."""
    clock = time.fromisoformat(hhmm)
    return pd.Timestamp(datetime.combine(day, clock, tzinfo=ET)).tz_convert("UTC")


@cache
def session(asset: Asset, day: date) -> Session | None:
    """The session for trading day `day`, or None when the exchange is closed."""
    cal = _calendar(asset)
    label = pd.Timestamp(day)
    if not cal.is_session(label):
        return None
    close = cal.session_close(label)
    if asset == "stock":
        return Session(day, et(day, "04:00"), cal.session_open(label), close, close + timedelta(hours=4))
    return Session(
        day,
        cal.session_open(label),
        et(day, "09:30"),
        min(close, et(day, "16:00")),
        min(close, et(day, "17:00")),
    )


def previous_session(asset: Asset, day: date) -> date:
    """The trading day before `day` (`day` itself need not be a trading day)."""
    label = pd.Timestamp(day) - pd.Timedelta(days=1)
    return _calendar(asset).date_to_session(label, direction="previous").date()


def annotate(bars: pd.DataFrame, asset: Asset) -> pd.DataFrame:
    """Adds `day` (trading day) and `phase` ("pre", "regular", "post") to 1-minute bars.

    `bars` is indexed by the UTC bar start. Bars outside every session's extended hours, or on
    days the exchange is closed, are dropped.
    """
    shift = pd.Timedelta(hours=6) if asset == "future" else pd.Timedelta(0)
    days = pd.Index((bars.index.tz_convert(ET) + shift).date)
    phases = np.full(len(bars), None, dtype=object)
    for day in days.unique():
        found = session(asset, day)
        if found is None:
            continue
        rows = np.flatnonzero(days == day)
        starts = bars.index[rows]
        phases[rows] = np.select(
            [
                starts < found.extended_open,
                starts < found.regular_open,
                starts < found.regular_close,
                starts < found.extended_close,
            ],
            [None, "pre", "regular", "post"],
            default=None,
        )
    out = bars.assign(day=days, phase=phases)
    return out[out["phase"].notna()]
