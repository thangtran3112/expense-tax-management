"""Evaluates a strategy spec on closed bars into signal candidates (02a section 5).

Rules see closed bars only: a 1-minute bar counts once its minute has ended, a daily bar once
its regular session has closed. A strategy fires when its rule turns true at an evaluation point
(a rising edge), so a rule that stays true does not fire again:
- bar_close_1m: every closed 1-minute bar in the watched session; the edge resets each day.
- premarket_0830: once per trading day at 08:30 ET, from the bars closed by then; no edge.
- daily_close: every closed daily bar. weekly: the last trading day of each finished week.
"""

import json
from dataclasses import dataclass, field
from datetime import date, time
from typing import Any

import numpy as np
import pandas as pd

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core import indicators, levels
from ai_trading.core.calendar import ET, Asset, annotate, et, session

INTRADAY_CADENCES = {"bar_close_1m", "premarket_0830"}
_SESSION_LEVELS = {"premarket_high", "premarket_low", "overnight_high", "overnight_low"}
_OPENING_LEVELS = {"opening_range_high", "opening_range_low"}
_COMPARE = {"gt": np.greater, "gte": np.greater_equal, "lt": np.less, "lte": np.less_equal}


@dataclass(frozen=True)
class SignalCandidate:
    symbol: str
    bar_time: pd.Timestamp
    evidence: dict[str, float]


def _nodes(condition: dict[str, Any]):
    yield condition
    for child in condition.get("all", []) + condition.get("any", []):
        yield from _nodes(child)
    if "not" in condition:
        yield from _nodes(condition["not"])


def _operands(condition: dict[str, Any]):
    for node in _nodes(condition):
        for side in ("left", "right"):
            if side in node and "value" not in node[side]:
                yield node[side]


def label(operand: dict[str, Any]) -> str:
    """Evidence key, e.g. "close", "sma(20)", "opening_range_high(15)"."""
    name = operand.get("series") or operand["level"]
    arg = operand.get("length") or operand.get("lookbackDays") or operand.get("minutes") or operand.get("days")
    return f"{name}({arg})" if arg else name


def check(spec: StrategySpecV1) -> list[str]:
    """Rules the JSON Schema cannot express: operands that the cadence cannot compute."""
    run_on = spec.watch.runOn
    when = spec.model_dump(by_alias=True, exclude_none=True)["when"]
    intraday_only = {"vwap"} | _SESSION_LEVELS | _OPENING_LEVELS
    problems = []
    for operand in _operands(when):
        name = operand.get("series") or operand["level"]
        if run_on not in INTRADAY_CADENCES and name in intraday_only:
            problems.append(f"{name} needs intraday bars; {run_on} uses daily bars")
        if run_on == "premarket_0830" and name in intraday_only:
            problems.append(f"{name} is not known at 08:30 ET")
    if run_on not in INTRADAY_CADENCES and any(n.get("op") == "time_between" for n in _nodes(when)):
        problems.append(f"time_between needs intraday bars; {run_on} uses daily bars")
    return problems


@dataclass(frozen=True)
class _Frame:
    bars: pd.DataFrame  # annotated 1-minute bars, or daily bars indexed by date
    days: pd.Index  # trading day of each row
    daily: pd.DataFrame
    asset: Asset
    intraday: bool
    cache: dict[str, pd.Series] = field(default_factory=dict)

    def per_day(self, values: pd.Series) -> pd.Series:
        return pd.Series(values.reindex(self.days).to_numpy(), index=self.bars.index)


def _series(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    key = json.dumps(operand, sort_keys=True)
    if key not in frame.cache:
        frame.cache[key] = _compute(operand, frame)
    return frame.cache[key]


def _compute(operand: dict[str, Any], frame: _Frame) -> pd.Series:
    bars = frame.bars
    if "value" in operand:
        return pd.Series(float(operand["value"]), index=bars.index)
    unique_days = pd.Index(frame.days.unique())
    if "level" in operand:
        name = operand["level"]
        if name.startswith("prior_day_"):
            column = name.removeprefix("prior_day_")
            return frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, column))
        if name.startswith("n_day_"):
            column = name.removeprefix("n_day_")
            return frame.per_day(levels.n_day(frame.daily, unique_days, operand["days"], column))
        if name in _SESSION_LEVELS:
            return levels.pre_phase(bars, name.rsplit("_", 1)[1])
        return levels.opening_range(bars, frame.asset, operand["minutes"], name.rsplit("_", 1)[1])
    name = operand["series"]
    if name in ("open", "high", "low", "close", "volume"):
        return bars[name].astype(float)
    if name == "vwap":
        return indicators.session_vwap(bars)
    if name in ("sma", "ema", "rsi"):
        return getattr(indicators, name)(bars["close"], operand["length"])
    if name == "atr":
        return indicators.atr(bars, operand["length"])
    if name == "rvol":
        if frame.intraday:
            return indicators.rvol_intraday(bars, operand["lookbackDays"])
        return indicators.rvol_daily(bars, operand["lookbackDays"])
    # gap_pct: intraday, last price against the prior regular close; daily, open against it.
    if frame.intraday:
        prior = frame.per_day(levels.prior_day(frame.daily, unique_days, frame.asset, "close"))
        return (bars["close"] - prior) / prior * 100
    prior = bars["close"].shift(1)
    return (bars["open"] - prior) / prior * 100


def _truth(values: np.ndarray, known: pd.Series) -> pd.Series:
    return pd.Series(values, index=known.index, dtype="boolean").mask(~known)


def _condition(node: dict[str, Any], frame: _Frame) -> pd.Series:
    if "all" in node or "any" in node:
        parts = [_condition(child, frame) for child in node.get("all") or node["any"]]
        out = parts[0]
        for part in parts[1:]:
            out = (out & part) if "all" in node else (out | part)
        return out
    if "not" in node:
        return ~_condition(node["not"], frame)
    op = node["op"]
    if op == "time_between":
        clock = frame.bars.index.tz_convert(ET).time
        start, end = time.fromisoformat(node["start"]), time.fromisoformat(node["end"])
        inside = (clock >= start) & (clock < end) if start <= end else (clock >= start) | (clock < end)
        return pd.Series(inside, index=frame.bars.index, dtype="boolean")
    left, right = _series(node["left"], frame), _series(node["right"], frame)
    known = left.notna() & right.notna()
    if op in _COMPARE:
        return _truth(_COMPARE[op](left.to_numpy(), right.to_numpy()), known)
    if op == "within_pct":
        near = (left - right).abs().to_numpy() <= node["pct"] / 100 * right.abs().to_numpy()
        return _truth(near, known)
    # crosses: now beyond, and the previous bar at or behind. A level that only became known on
    # this bar is compared with its current value.
    before_right = right.shift(1).fillna(right)
    before_left = left.shift(1)
    if op == "crosses_above":
        now, before = left > right, before_left <= before_right
    else:
        now, before = left < right, before_left >= before_right
    return _truth((now & before).to_numpy(), known & before_left.notna())


def _points(run_on: str, frame: _Frame, session_name: str, as_of: pd.Timestamp) -> pd.Series:
    """Maps each evaluation point's time (index) to the frame row it reads (values)."""
    bars = frame.bars
    if run_on == "bar_close_1m":
        rows = bars.index if session_name == "extended" else bars.index[bars["phase"] == "regular"]
        return pd.Series(rows, index=rows)
    if run_on == "premarket_0830":
        out = {}
        for day, rows in bars.groupby("day").groups.items():
            point = et(day, "08:30")
            closed = rows[rows < point]  # bars that started before 08:30 have closed by then
            if point <= as_of and len(closed):
                out[point] = closed[-1]
        return pd.Series(out, dtype=object)
    closes = {day: session(frame.asset, day).regular_close for day in bars.index}
    days = list(bars.index)
    if run_on == "weekly":
        days = [day for day in days if _last_of_week(frame.asset, day)]
    return pd.Series(days, index=pd.DatetimeIndex([closes[day] for day in days]), dtype=object)


def _last_of_week(asset: Asset, day: date) -> bool:
    """True when no later trading day falls in the same ISO week."""
    for offset in range(1, 7 - day.weekday()):
        later = pd.Timestamp(day) + pd.Timedelta(days=offset)
        if session(asset, later.date()) is not None:
            return False
    return True


def evaluate(
    spec: StrategySpecV1,
    symbol: str,
    asset: Asset,
    *,
    bars_1m: pd.DataFrame | None,
    bars_1d: pd.DataFrame,
    as_of: pd.Timestamp,
) -> list[SignalCandidate]:
    """Signal candidates for every evaluation point closed by `as_of`.

    `bars_1m`: OHLCV indexed by UTC bar start (needed by intraday cadences).
    `bars_1d`: regular-session OHLCV indexed by trading day (`datetime.date`).
    """
    problems = check(spec)
    if problems:
        raise ValueError("; ".join(problems))
    run_on = spec.watch.runOn
    closed_days = [day for day in bars_1d.index if session(asset, day).regular_close <= as_of]
    daily = bars_1d.loc[closed_days].sort_index()
    if run_on in INTRADAY_CADENCES:
        if bars_1m is None:
            raise ValueError(f"{run_on} needs 1-minute bars")
        closed = bars_1m[bars_1m.index + pd.Timedelta(minutes=1) <= as_of].sort_index()
        bars = annotate(closed, asset)
        frame = _Frame(bars, pd.Index(bars["day"]), daily, asset, intraday=True)
    else:
        frame = _Frame(daily, daily.index, daily, asset, intraday=False)

    when = spec.model_dump(by_alias=True, exclude_none=True)["when"]
    truth = _condition(when, frame)
    points = _points(run_on, frame, spec.watch.session, as_of)
    if points.empty:
        return []
    rows = pd.Index(points.to_numpy())
    now = pd.Series(truth.reindex(rows).fillna(False).to_numpy(dtype=bool), index=points.index)
    if run_on == "premarket_0830":
        fired = now
    else:
        groups = frame.days.to_series(index=frame.bars.index).reindex(rows).to_numpy()
        before = now.groupby(groups if run_on == "bar_close_1m" else np.zeros(len(now))).shift(1)
        fired = now & ~before.fillna(False).astype(bool)

    evidence = {label(op): _series(op, frame).reindex(rows).to_numpy() for op in _operands(when)}
    out = []
    for position in np.flatnonzero(fired.to_numpy()):
        values = {key: round(float(series[position]), 6) for key, series in evidence.items()}
        out.append(SignalCandidate(symbol, points.index[position], values))
    return out
