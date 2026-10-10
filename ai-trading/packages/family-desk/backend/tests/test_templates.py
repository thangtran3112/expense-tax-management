"""Golden tests: each template fires on its setup, stays silent on a near miss, and never repaints."""

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import pandas as pd
import pytest
from bars import daily_bars, minute_bars, set_bar, trading_days

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1
from ai_trading.core.calendar import Asset, et, session
from ai_trading.core.evaluate import SignalCandidate, evaluate

TEMPLATES = Path(__file__).resolve().parents[2] / "contracts" / "templates"
DAY = date(2026, 10, 6)  # a Tuesday


@dataclass
class Scenario:
    asset: Asset
    bars_1m: pd.DataFrame | None
    bars_1d: pd.DataFrame


def load(name: str) -> StrategySpecV1:
    return StrategySpecV1.model_validate_json((TEMPLATES / f"{name}.json").read_text())


def stock_history(volume_today: float = 1_000.0, price: float = 100.0) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Ten flat days at 1,000 shares a minute, then today at `volume_today`."""
    days = trading_days("stock", DAY, 11)
    bars = pd.concat(
        [minute_bars("stock", day, price) for day in days[:-1]] + [minute_bars("stock", DAY, price, volume_today)]
    )
    return bars, daily_bars(days[:-1], [price] * 10)


def closes(bars: pd.DataFrame, start: str, end: str, value: float) -> None:
    for at in pd.date_range(et(DAY, start), et(DAY, end), freq="1min", inclusive="left"):
        bars.loc[at, ["open", "high", "low", "close"]] = value


def orb_breakout(fire: bool) -> Scenario:
    bars, daily = stock_history(volume_today=3_000.0 if fire else 1_500.0)  # rvol 3 or 1.5
    set_bar(bars, DAY, "09:35", high=101.0)
    set_bar(bars, DAY, "10:00", close=101.5)
    return Scenario("stock", bars, daily)


def vwap_reclaim(fire: bool) -> Scenario:
    bars, daily = stock_history()
    closes(bars, "09:31", "10:00" if fire else "09:40", 99.0)  # near miss reclaims before 09:45
    return Scenario("stock", bars, daily)


def vwap_loss(fire: bool) -> Scenario:
    bars, daily = stock_history()
    if fire:
        closes(bars, "09:31", "10:00", 101.0)
    else:
        closes(bars, "15:00", "15:30", 101.0)  # loses VWAP at 15:30, when the window has ended
    return Scenario("stock", bars, daily)


def premarket_high_break(fire: bool) -> Scenario:
    bars, daily = stock_history(volume_today=3_000.0)
    set_bar(bars, DAY, "08:00", high=102.0)
    set_bar(bars, DAY, "09:45" if fire else "11:00", close=102.5)  # 11:00 ends the window
    return Scenario("stock", bars, daily)


def gap_and_go(fire: bool) -> Scenario:
    bars, daily = stock_history()
    closes(bars, "04:00", "08:30", 104.0 if fire else 102.9)
    bars.loc[et(DAY, "04:00") : et(DAY, "08:29"), "volume"] = 3_000.0
    return Scenario("stock", bars, daily)


def futures_overnight_range_break(fire: bool) -> Scenario:
    bars = minute_bars("future", DAY, price=5_000.0)
    set_bar(bars, date(2026, 10, 5), "22:00", high=5_010.0)
    set_bar(bars, DAY, "02:00", low=4_990.0)
    set_bar(bars, DAY, "10:15", close=5_011.0 if fire else 5_010.0)  # touching is not breaking
    return Scenario("future", bars, daily_bars([], []))


def volume_spike(fire: bool) -> Scenario:
    bars, daily = stock_history()
    set_bar(bars, DAY, "10:30", volume=200_000.0 if fire else 122_000.0)  # rvol 4.26 or 2.98
    return Scenario("stock", bars, daily)


def n_day_breakout(fire: bool) -> Scenario:
    days = trading_days("stock", DAY, 60)
    daily = daily_bars(days, [100.0] * 60)
    daily.loc[DAY, ["close", "high"]] = 101.0
    daily.loc[DAY, "volume"] = 2_000_000.0 if fire else 1_400_000.0  # rvol 2 or 1.4
    return Scenario("stock", None, daily)


def pullback_to_average(fire: bool) -> Scenario:
    days = trading_days("stock", DAY, 60)
    rising = [100.0 + n for n in range(59)]
    # 150 is 0.64% from the 20-day average (149.05); 153 is 2.5% away.
    return Scenario("stock", None, daily_bars(days, rising + [150.0 if fire else 153.0]))


def rsi_reversal(fire: bool) -> Scenario:
    falling = [100.0 - n for n in range(20)]  # RSI(14) reaches 0
    rising = [82.0 + n for n in range(5 if fire else 4)]  # the fifth up day lifts it past 30
    closing = falling + rising
    return Scenario("stock", None, daily_bars(trading_days("stock", DAY, len(closing)), closing))


CASES: dict[str, tuple[Callable[[bool], Scenario], str, dict[str, float]]] = {
    "orb-breakout": (
        orb_breakout,
        "10:00",
        {"close": 101.5, "opening_range_high(15)": 101.0, "rvol(10)": 3.0, "vwap": 100.043011},
    ),
    "vwap-reclaim": (vwap_reclaim, "10:00", {"close": 100.0, "vwap": 99.064516}),
    "vwap-loss": (vwap_loss, "10:00", {"close": 100.0, "vwap": 100.935484}),
    "premarket-high-break": (
        premarket_high_break,
        "09:45",
        {"close": 102.5, "premarket_high": 102.0, "rvol(10)": 3.0},
    ),
    "gap-and-go": (gap_and_go, "08:30", {"gap_pct": 4.0, "rvol(10)": 3.0}),
    "futures-overnight-range-break": (
        futures_overnight_range_break,
        "10:15",
        {"close": 5_011.0, "overnight_high": 5_010.0, "overnight_low": 4_990.0},
    ),
    "volume-spike": (volume_spike, "10:30", {"rvol(10)": 4.262295}),
    "n-day-breakout": (
        n_day_breakout,
        "16:00",
        {"close": 101.0, "n_day_high(20)": 100.0, "rvol(20)": 2.0},
    ),
    "pullback-to-average": (
        pullback_to_average,
        "16:00",
        {"sma(20)": 149.05, "sma(50)": 134.32, "close": 150.0},
    ),
    "rsi-reversal": (rsi_reversal, "16:00", {"rsi(14)": 30.963847}),
}


def run(name: str, scenario: Scenario, as_of: pd.Timestamp) -> list[SignalCandidate]:
    return evaluate(load(name), "TEST", scenario.asset, bars_1m=scenario.bars_1m, bars_1d=scenario.bars_1d, as_of=as_of)


def end_of(scenario: Scenario) -> pd.Timestamp:
    return session(scenario.asset, DAY).extended_close


def test_every_template_has_a_golden_case():
    assert sorted(CASES) == sorted(path.stem for path in TEMPLATES.glob("*.json"))


@pytest.mark.parametrize("name", sorted(CASES))
def test_fires_on_its_setup(name: str):
    build, clock, evidence = CASES[name]
    scenario = build(True)
    found = run(name, scenario, end_of(scenario))
    assert [c.bar_time for c in found] == [et(DAY, clock)]
    assert found[0].evidence == evidence


@pytest.mark.parametrize("name", sorted(CASES))
def test_stays_silent_on_the_near_miss(name: str):
    build, _, _ = CASES[name]
    scenario = build(False)
    assert run(name, scenario, end_of(scenario)) == []


@pytest.mark.parametrize("name", sorted(CASES))
def test_never_repaints(name: str):
    """At every moment, the signals so far are exactly the final signals known by then."""
    build, clock, _ = CASES[name]
    scenario = build(True)
    spec = load(name)
    final = run(name, scenario, end_of(scenario))
    lag = pd.Timedelta(minutes=1) if spec.watch.runOn == "bar_close_1m" else pd.Timedelta(0)
    fired = et(DAY, clock)
    moments = [fired - pd.Timedelta(seconds=1), fired + lag - pd.Timedelta(seconds=1), fired + lag]
    if scenario.bars_1m is not None:
        moments += list(pd.date_range(scenario.bars_1m.index[-1] - pd.Timedelta(hours=16), end_of(scenario), freq="2h"))
    for as_of in moments:
        assert run(name, scenario, as_of) == [c for c in final if c.bar_time + lag <= as_of], as_of
