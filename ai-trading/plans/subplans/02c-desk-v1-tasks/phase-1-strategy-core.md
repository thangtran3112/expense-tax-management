# Phase 1: Strategy Core

Part of [02c-desk-v1-implementation-plan.md](../02c-desk-v1-implementation-plan.md). Read its Global Constraints, Review Focus, and Shared Interfaces first.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Subagents work in a `.worktrees/` worktree on their own `feature/*` branch; the main session merges that branch into `feature/toby` (root `AGENTS.md`).

**Goal:** Ship the Desk's strategy core with no I/O: the versioned strategy-spec contract (Zod, JSON Schema, Pydantic), the session calendar, indicators, levels, the closed-bar evaluator, and ten intraday and swing templates with golden tests.

**Architecture:**
- `ai-trading/contracts` (pnpm): the Zod v4 schema is the source of truth. A script writes its JSON Schema. Shared fixtures and the templates live here, and both test suites read them.
- `ai-trading/backend` (uv, Python 3.12): `datamodel-code-generator` turns the JSON Schema into Pydantic models (`ai_trading.contracts`). `ai_trading.core` holds pure functions over pandas bars: `calendar`, `indicators`, `levels`, `evaluate`.
- `evaluate()` takes one symbol's closed bars and an `as_of` time and returns signal candidates with evidence. Phases 2 and 3 supply the bars and store the signals.

**Tech Stack:** Node 24 (local ≥ 22.18), pnpm 11.9.0, Zod 4.6, TypeScript 5.9, `node:test`; Python 3.12, uv, pandas, numpy, exchange-calendars, Pydantic 2, datamodel-code-generator 0.83.0, pytest, ruff.

**Spec:**
- [02a §4–5, §13](../02a-desk-v1-strategies-design.md): strategy model, block library, templates, runtime rules, testing
- [02c Phase 1 outline](../02c-desk-v1-implementation-plan.md#phase-1-strategy-core-no-io), Shared Interfaces, and Review Focus 2–3

## Global Constraints

- Everything in 02c's Global Constraints applies, notably: JSON specs with `schemaVersion: 1`; Zod is the source of truth; closed bars only; dedupe by (strategy version, symbol, bar time); stages and the paper guard are not touched here.
- Python `>=3.12,<3.13`; Node ≥ 22.18 locally (it runs `.ts` files natively), Node 24 in CI; pnpm 11.9.0.
- Dependencies, and no others. Contracts: `zod`; dev `typescript`, `@types/node`. Backend: `exchange-calendars`, `numpy`, `pandas`, `pydantic`; dev `datamodel-code-generator==0.83.0` (exact, because its output is checked in), `pytest`, `ruff`.
- `ai_trading.core` does no I/O: no network, files, database, environment, or clock. The current time is the `as_of` argument.
- Never hand-edit the two generated files. `contracts/generated/strategy-spec-v1.schema.json` comes from `pnpm generate:json-schema`, and `backend/src/ai_trading/contracts/strategy_spec_v1.py` from `scripts/generate-contracts.sh`. Each test suite fails when its file drifts.
- Bars: 1-minute bars are indexed by UTC bar start. Daily bars are regular-session OHLCV indexed by trading day (`datetime.date`). Phase 2's bar store must deliver both shapes.
- Test data uses made-up prices and volumes (public repository).
- Commits are one line, with no trailer. Do not push; the main session merges.

## Decisions for Owner Review

The spec is silent on these. The plan decides them as below, and the owner confirms or changes them before execution.

1. **A rule fires on its rising edge.** A strategy fires when its rule turns true at an evaluation point, not on every bar while it stays true. For `bar_close_1m` the edge resets each trading day. `premarket_0830` runs once a day, so it fires every day the rule is true. `cooldownMinutes` and `maxTradesPerDay` add more throttling at runtime (Phase 3).
2. **Futures roots start with `/`** (`/ES`, `/MNQ`) in `watch.universe.symbols`, because `ES`, `CL`, and `GC` are also stock tickers.
3. **Sessions.** Stocks: pre 04:00–09:30 ET, regular 09:30–16:00 (13:00 on half days), post for 4 hours after the regular close. Futures (CME calendar): the overnight session from 18:00 ET the evening before is the "pre" phase, regular is 09:30–16:00 ET (earlier on CME early closes), and post runs to 17:00 ET. `premarket_*` and `overnight_*` levels both read the pre phase.
4. **VWAP covers the regular session** and is unknown before the open.
5. **Relative volume.** Intraday: volume so far in today's phase, over the average at the same clock time on the previous N days that have data. Daily: the day's volume over the average of the previous N days.
6. **`gap_pct`.** Intraday: the last price against the prior regular close. Daily: the open against the prior close.
7. **Series use the cadence's bars:** 1-minute bars for `bar_close_1m` and `premarket_0830`, daily bars for `daily_close` and `weekly`. 02a lists "RSI(n, timeframe)". v1 has no per-operand timeframe; adding one later is an optional field, so it is not a breaking change.
8. **Spec field names** (02a §4.3 left them to the contracts package): `size: {riskUsd | shares | pctOfBook | contracts}`, `stop: {level…} | {atrMultiple}`, `target: {r} | {level…}`. 02a's example used `riskUsd` and `targetR` directly on `paperOrder`.
9. **Ten templates** live in `ai-trading/contracts/templates/`, so the builder (Phase 4) and seeding (Phase 3) share one copy. VWAP reclaim and VWAP loss are separate templates, because one strategy holds one order side. The long-term templates come in Phase 5.
10. **The evaluator does not enforce limits.** `maxTradesPerDay`, `cooldownMinutes`, `flatBy`, and pauses belong to the runtime (Phase 3) and the broker (Phase 6).
11. **Tooling differs from 02c's outline.** `node:test` replaces vitest; the hub already uses it, so that is one dependency fewer. Each test suite checks its generated file for drift, instead of a separate `check-generated.mjs`.
12. **Phase 1 covers the intraday and swing blocks only.** The rest of 02a §4.4 arrives with its data, as new union members, so existing specs stay valid:
    - % from the 52-week high, IV30, IV rank, earnings and ex-dividend windows, and support/resistance come with Phase 2's data;
    - fundamentals, options, `persona_review`, `paperCoveredCall`, cost basis, and short-call strike come in Phase 5.

## Review Focus

These inputs are the most likely to hurt a user. Each line names the test that pins it.

1. **Zod and Pydantic disagree,** so the API rejects a spec the builder accepted, or the reverse. Pinned by the shared fixtures: `test/strategy-spec-v1.test.ts` and `tests/test_contracts.py` (Tasks 1.1–1.2), including `schemaVersion: true`, `1e400`, and nulls. The one known asymmetry: Pydantic rejects an integer written as `20.0`, which Zod accepts. `JSON.stringify` and Python's `json` never write integers that way.
2. **Repainting.** A partial bar must never fire, and the signals known at any moment must equal the final signals known by then. Pinned by `test_a_bar_counts_only_once_its_minute_has_ended` (Task 1.6) and `test_never_repaints` for every template (Task 1.7).
3. **Session edges:** daylight-saving changes, half days, holidays, and the futures Sunday 18:00 ET open. Pinned by `tests/test_calendar.py` (Task 1.3), plus the half-day and Good Friday cases in `tests/test_evaluate.py` (Task 1.6).
4. **Missing data must never make a rule true,** even under `not`, and a missing prior day is never replaced by an older one. Pinned by `test_missing_data_is_unknown_even_under_not` (Task 1.6) and `test_prior_day_skips_the_holiday_and_never_substitutes` (Task 1.5).
5. **A rule that stays true must not alert every minute.** Pinned by `test_a_rule_that_stays_true_fires_on_each_rising_edge` and `test_the_edge_resets_each_trading_day` (Task 1.6), and by the volume-spike golden case (Task 1.7).

## File Map

| Path | Responsibility |
|---|---|
| `ai-trading/contracts/src/strategy-spec-v1.ts` | Zod schema `StrategySpecV1Schema` and its types |
| `ai-trading/contracts/scripts/generate-json-schema.ts` | Writes `generated/strategy-spec-v1.schema.json` |
| `ai-trading/contracts/fixtures/strategy-spec-v1/{valid,invalid}/*.json` | Specs both validators must accept or reject |
| `ai-trading/contracts/templates/*.json` | The ten seeded templates (also valid fixtures) |
| `ai-trading/contracts/test/strategy-spec-v1.test.ts` | Zod against the fixtures and templates; JSON Schema drift |
| `ai-trading/backend/scripts/generate-contracts.sh` | JSON Schema → `ai_trading/contracts/strategy_spec_v1.py` |
| `ai-trading/backend/src/ai_trading/contracts/base.py` | `SpecModel`: makes Pydantic reject what Zod rejects |
| `ai-trading/backend/src/ai_trading/core/calendar.py` | Sessions, previous trading day, bar phases |
| `ai-trading/backend/src/ai_trading/core/indicators.py` | SMA, EMA, RSI, ATR, session VWAP, relative volume |
| `ai-trading/backend/src/ai_trading/core/levels.py` | Prior-day, N-day, pre-market/overnight, opening range |
| `ai-trading/backend/src/ai_trading/core/evaluate.py` | `check()`, `evaluate()`, `SignalCandidate` |
| `ai-trading/backend/tests/bars.py` | Synthetic bar builders for tests |
| `.github/workflows/ai-trading-ci.yml` | New `desk` job |

All commands below run from the repository root unless a step says otherwise.

---

### Task 1.1: Contracts package

**Files:**
- Create: `ai-trading/contracts/package.json`, `tsconfig.json`, `src/strategy-spec-v1.ts`, `scripts/generate-json-schema.ts`, `test/strategy-spec-v1.test.ts`
- Create: `ai-trading/contracts/fixtures/strategy-spec-v1/valid/*.json` (3) and `invalid/*.json` (23)
- Generated: `ai-trading/contracts/pnpm-lock.yaml`, `ai-trading/contracts/generated/strategy-spec-v1.schema.json`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `StrategySpecV1Schema` (Zod), types `StrategySpecV1`, `Condition`, `Operand`
  - `FILE_NAME = "strategy-spec-v1.schema.json"`, `renderJsonSchema(): string`, `writeJsonSchema(dir): Promise<string>`
  - the fixture layout that Task 1.2's Python tests read

- [ ] **Step 1: Create the package.**

`ai-trading/contracts/package.json`:

```json
{
  "name": "@ai-trading/contracts",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/strategy-spec-v1.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test test/strategy-spec-v1.test.ts",
    "generate:json-schema": "node scripts/generate-json-schema.ts"
  },
  "dependencies": {
    "zod": "^4.6.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "typescript": "^5.9.3"
  },
  "packageManager": "pnpm@11.9.0",
  "engines": {
    "node": ">=22.18.0"
  }
}
```

`ai-trading/contracts/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src", "scripts", "test"]
}
```

Run: `cd ai-trading/contracts && pnpm install`
Expected: `pnpm-lock.yaml` is created, with zod 4.6.x.

- [ ] **Step 2: Write the valid fixtures** in `ai-trading/contracts/fixtures/strategy-spec-v1/valid/`.

`minimal.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`futures-symbols-and-nested-logic.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "symbols": ["/ES", "/MNQ", "BRK.B", "SPY"] }, "session": "extended", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "not": { "op": "lt", "left": { "series": "ema", "length": 9 }, "right": { "series": "ema", "length": 21 } } },
      { "any": [
        { "op": "within_pct", "left": { "series": "close" }, "right": { "level": "prior_day_close" }, "pct": 0.5 },
        { "op": "crosses_below", "left": { "series": "close" }, "right": { "level": "overnight_low" } }
      ] },
      { "op": "time_between", "start": "18:00", "end": "02:00" }
    ]
  },
  "then": { "alert": { "channels": ["inbox", "slack"], "severity": "risk" } }
}
```

`all-paper-order-and-limit-fields.json`:

```json
{
  "schemaVersion": 1,
  "name": "Fixture",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "daily_close" },
  "when": { "op": "gte", "left": { "series": "atr", "length": 14 }, "right": { "value": 2.5 } },
  "then": {
    "alert": { "channels": ["telegram"] },
    "paperOrder": { "side": "sell", "size": { "contracts": 1 }, "stop": { "level": "n_day_high", "days": 10 }, "target": { "level": "prior_day_low" } }
  },
  "limits": { "maxTradesPerDay": 12, "maxOpenPositions": 1, "maxPositionUsd": 5000.5, "flatBy": "00:00", "pauseAfterDailyLossUsd": 250, "cooldownMinutes": 0 }
}
```

- [ ] **Step 3: Write the invalid fixtures** in `ai-trading/contracts/fixtures/strategy-spec-v1/invalid/`. Each file breaks exactly one rule, which its name states.

`empty-all.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "all": [] }, "then": { "alert": { "channels": ["inbox"] } } }
```

`empty-channels.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": [] } } }
```

`flat-by-hour-24.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": { "flatBy": "24:00" } }
```

`flat-by-one-digit-hour.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": { "flatBy": "9:55" } }
```

`flat-by-trailing-newline.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": { "flatBy": "15:55\n" } }
```

`flat-by-yaml-number.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": { "flatBy": 955 } }
```

`length-fraction.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "sma", "length": 20.5 }, "right": { "value": 1 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`length-string.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "sma", "length": "20" }, "right": { "value": 1 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`lowercase-symbol.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "symbols": ["aapl"] }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`max-trades-over-family-cap.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": { "maxTradesPerDay": 13 } }
```

`missing-schema-version.json`:

```json
{ "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`null-limits.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "limits": null }
```

`opening-range-zero-minutes.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "level": "opening_range_high", "minutes": 0 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`paper-order-two-sizes.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] }, "paperOrder": { "side": "buy", "size": { "shares": 10, "riskUsd": 100 }, "stop": { "atrMultiple": 1 }, "target": { "r": 2 } } } }
```

`paper-order-without-stop.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] }, "paperOrder": { "side": "buy", "size": { "shares": 10 }, "target": { "r": 2 } } } }
```

`schema-version-2.json`:

```json
{ "schemaVersion": 2, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`schema-version-boolean.json`:

```json
{ "schemaVersion": true, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`schema-version-string.json`:

```json
{ "schemaVersion": "1", "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`sma-without-length.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "sma" }, "right": { "value": 1 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`unknown-channel.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["sms"] } } }
```

`unknown-operator.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "equals", "left": { "series": "close" }, "right": { "value": 1 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

`unknown-top-level-key.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 100 } }, "then": { "alert": { "channels": ["inbox"] } }, "notes": "x" }
```

`value-overflows-to-infinity.json`:

```json
{ "schemaVersion": 1, "name": "Fixture", "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" }, "when": { "op": "gt", "left": { "series": "close" }, "right": { "value": 1e400 } }, "then": { "alert": { "channels": ["inbox"] } } }
```

- [ ] **Step 4: Write the failing test** `ai-trading/contracts/test/strategy-spec-v1.test.ts`:

```typescript
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FILE_NAME, renderJsonSchema } from "../scripts/generate-json-schema.ts";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsonFiles(directory: string): [string, unknown][] {
  const full = path.join(root, directory);
  if (!existsSync(full)) return [];
  return readdirSync(full)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(path.join(full, name), "utf8"))]);
}

const valid = jsonFiles("fixtures/strategy-spec-v1/valid");
const invalid = jsonFiles("fixtures/strategy-spec-v1/invalid");
const templates = jsonFiles("templates");

test("fixture folders are not empty", () => {
  assert.ok(valid.length >= 3 && invalid.length >= 20);
});

for (const [name, spec] of [...valid, ...templates]) {
  test(`accepts ${name}`, () => {
    const result = StrategySpecV1Schema.safeParse(spec);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });
}

for (const [name, spec] of invalid) {
  test(`rejects ${name}`, () => {
    assert.equal(StrategySpecV1Schema.safeParse(spec).success, false);
  });
}

test("generated JSON Schema is current (run pnpm generate:json-schema)", () => {
  const checkedIn = readFileSync(path.join(root, "generated", FILE_NAME), "utf8");
  assert.equal(checkedIn, renderJsonSchema());
});
```

- [ ] **Step 5: Run it and watch it fail.**

Run: `cd ai-trading/contracts && pnpm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `../scripts/generate-json-schema.ts`.

- [ ] **Step 6: Write the schema** `ai-trading/contracts/src/strategy-spec-v1.ts`:

```typescript
import { z } from "zod";

// "HH:MM" in America/New_York. [0-9], not \d: Python's regex engine would also
// accept non-ASCII digits for \d, and both validators must agree.
const HhMmSchema = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
// A leading "/" marks a futures root (/ES): ES, CL, and GC are also stock tickers.
const TickerSchema = z.string().regex(/^\/?[A-Z][A-Z0-9.]{0,9}$/);

export const SeriesOperandSchema = z
  .union([
    z.strictObject({
      series: z.enum(["open", "high", "low", "close", "volume", "vwap", "gap_pct"]),
    }),
    z.strictObject({
      series: z.enum(["sma", "ema", "rsi", "atr"]),
      length: z.int().min(2).max(500),
    }),
    z.strictObject({
      series: z.literal("rvol"),
      lookbackDays: z.int().min(1).max(60),
    }),
  ])
  .meta({ id: "SeriesOperand" });

export const LevelOperandSchema = z
  .union([
    z.strictObject({
      level: z.enum([
        "prior_day_high",
        "prior_day_low",
        "prior_day_close",
        "premarket_high",
        "premarket_low",
        "overnight_high",
        "overnight_low",
      ]),
    }),
    z.strictObject({
      level: z.enum(["opening_range_high", "opening_range_low"]),
      minutes: z.int().min(1).max(120),
    }),
    z.strictObject({
      level: z.enum(["n_day_high", "n_day_low"]),
      days: z.int().min(2).max(260),
    }),
  ])
  .meta({ id: "LevelOperand" });

export const ValueOperandSchema = z
  .strictObject({ value: z.number() })
  .meta({ id: "ValueOperand" });

export const OperandSchema = z
  .union([SeriesOperandSchema, LevelOperandSchema, ValueOperandSchema])
  .meta({ id: "Operand" });

const CompareConditionSchema = z
  .strictObject({
    op: z.enum(["gt", "gte", "lt", "lte", "crosses_above", "crosses_below"]),
    left: OperandSchema,
    right: OperandSchema,
  })
  .meta({ id: "CompareCondition" });

const WithinPctConditionSchema = z
  .strictObject({
    op: z.literal("within_pct"),
    left: OperandSchema,
    right: OperandSchema,
    pct: z.number().positive().max(100),
  })
  .meta({ id: "WithinPctCondition" });

const TimeBetweenConditionSchema = z
  .strictObject({
    op: z.literal("time_between"),
    start: HhMmSchema,
    end: HhMmSchema,
  })
  .meta({ id: "TimeBetweenCondition" });

const AllConditionSchema = z
  .strictObject({
    get all(): z.ZodArray<typeof ConditionSchema> {
      return z.array(ConditionSchema).min(1).max(20);
    },
  })
  .meta({ id: "AllCondition" });

const AnyConditionSchema = z
  .strictObject({
    get any(): z.ZodArray<typeof ConditionSchema> {
      return z.array(ConditionSchema).min(1).max(20);
    },
  })
  .meta({ id: "AnyCondition" });

const NotConditionSchema = z
  .strictObject({
    get not(): typeof ConditionSchema {
      return ConditionSchema;
    },
  })
  .meta({ id: "NotCondition" });

export const ConditionSchema = z
  .union([
    CompareConditionSchema,
    WithinPctConditionSchema,
    TimeBetweenConditionSchema,
    AllConditionSchema,
    AnyConditionSchema,
    NotConditionSchema,
  ])
  .meta({ id: "Condition" });

export const PaperOrderSchema = z
  .strictObject({
    side: z.enum(["buy", "sell"]),
    size: z.union([
      z.strictObject({ riskUsd: z.number().positive().max(100_000) }),
      z.strictObject({ shares: z.int().min(1).max(100_000) }),
      z.strictObject({ pctOfBook: z.number().positive().max(100) }),
      z.strictObject({ contracts: z.int().min(1).max(100) }),
    ]),
    stop: z.union([
      LevelOperandSchema,
      z.strictObject({ atrMultiple: z.number().positive().max(20) }),
    ]),
    target: z.union([
      z.strictObject({ r: z.number().positive().max(20) }),
      LevelOperandSchema,
    ]),
  })
  .meta({ id: "PaperOrder" });

export const LimitsSchema = z
  .strictObject({
    maxTradesPerDay: z.int().min(1).max(12).optional(),
    maxOpenPositions: z.int().min(1).max(10).optional(),
    maxPositionUsd: z.number().positive().max(1_000_000).optional(),
    flatBy: HhMmSchema.optional(),
    pauseAfterDailyLossUsd: z.number().positive().max(1_000_000).optional(),
    cooldownMinutes: z.int().min(0).max(1_440).optional(),
  })
  .meta({ id: "Limits" });

export const StrategySpecV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(80),
  watch: z.strictObject({
    universe: z.union([
      z.strictObject({ watchlist: z.string().min(1).max(80) }),
      z.strictObject({ symbols: z.array(TickerSchema).min(1).max(70) }),
    ]),
    session: z.enum(["regular", "extended"]),
    runOn: z.enum(["bar_close_1m", "premarket_0830", "daily_close", "weekly"]),
  }),
  when: ConditionSchema,
  then: z.strictObject({
    alert: z.strictObject({
      channels: z.array(z.enum(["inbox", "telegram", "slack"])).min(1).max(3),
      severity: z.enum(["info", "opportunity", "risk"]).optional(),
    }),
    paperOrder: PaperOrderSchema.optional(),
  }),
  limits: LimitsSchema.optional(),
});

export type StrategySpecV1 = z.infer<typeof StrategySpecV1Schema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type Operand = z.infer<typeof OperandSchema>;
```

- [ ] **Step 7: Write the generator** `ai-trading/contracts/scripts/generate-json-schema.ts`:

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { StrategySpecV1Schema } from "../src/strategy-spec-v1.ts";

export const FILE_NAME = "strategy-spec-v1.schema.json";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function renderJsonSchema(): string {
  const schema = z.toJSONSchema(StrategySpecV1Schema, {
    target: "draft-2020-12",
    io: "input",
  });
  return `${JSON.stringify(sortJson(schema), null, 2)}\n`;
}

export async function writeJsonSchema(outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, FILE_NAME);
  await writeFile(outputPath, renderJsonSchema(), "utf8");
  return outputPath;
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  await writeJsonSchema(fileURLToPath(new URL("../generated", import.meta.url)));
}
```

- [ ] **Step 8: Generate, test, and typecheck.**

Run: `cd ai-trading/contracts && pnpm generate:json-schema && pnpm test && pnpm typecheck`
Expected:
- `generated/strategy-spec-v1.schema.json` exists, about 600 lines, with `$defs` for `Condition`, `Operand`, and `PaperOrder`;
- `# pass 28`, `# fail 0`;
- no tsc output.

- [ ] **Step 9: Commit.**

```bash
git add ai-trading/contracts
git commit -m "feat(ai-trading): strategy spec v1 contracts package"
```

### Task 1.2: Backend scaffold and generated Pydantic models

**Files:**
- Create: `ai-trading/backend/pyproject.toml`, `.python-version`, `scripts/generate-contracts.sh`
- Create: `ai-trading/backend/src/ai_trading/__init__.py`, `src/ai_trading/contracts/__init__.py`, `src/ai_trading/core/__init__.py` (all three empty)
- Create: `ai-trading/backend/src/ai_trading/contracts/base.py`, `tests/test_contracts.py`
- Generated: `ai-trading/backend/uv.lock`, `ai-trading/backend/src/ai_trading/contracts/strategy_spec_v1.py`

**Interfaces:**
- Consumes: Task 1.1's JSON Schema and fixtures.
- Produces: `ai_trading.contracts.strategy_spec_v1.StrategySpecV1`, a Pydantic model. Use `StrategySpecV1.model_validate_json(raw)`, and `spec.model_dump(by_alias=True, exclude_none=True)` for the stored JSON shape (the `not` key is the alias of the field `not_`).

- [ ] **Step 1: Create the project.**

`ai-trading/backend/pyproject.toml`:

```toml
[project]
name = "ai-trading-desk"
version = "0.1.0"
description = "Family Desk backend"
requires-python = ">=3.12,<3.13"
dependencies = [
    "exchange-calendars>=4.13",
    "numpy>=2.2",
    "pandas>=2.3",
    "pydantic>=2.12",
]

[dependency-groups]
dev = [
    "datamodel-code-generator==0.83.0",  # exact: its output is checked in
    "pytest>=9.0",
    "ruff>=0.17",
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/ai_trading"]

[tool.ruff]
line-length = 120
extend-exclude = ["src/ai_trading/contracts/strategy_spec_v1.py"]

[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

`ai-trading/backend/.python-version`:

```text
3.12
```

Create the three empty `__init__.py` files, then:

Run: `cd ai-trading/backend && uv lock && uv sync`
Expected: `uv.lock` is created and Python 3.12 is installed into `.venv`.

- [ ] **Step 2: Write the failing test** `ai-trading/backend/tests/test_contracts.py`:

```python
import subprocess
import tempfile
from pathlib import Path

import pytest
from pydantic import ValidationError

from ai_trading.contracts.strategy_spec_v1 import StrategySpecV1

BACKEND = Path(__file__).resolve().parents[1]
CONTRACTS = BACKEND.parent / "contracts"
FIXTURES = CONTRACTS / "fixtures" / "strategy-spec-v1"


def _files(directory: Path) -> list[Path]:
    return sorted(directory.glob("*.json"))


VALID = _files(FIXTURES / "valid") + _files(CONTRACTS / "templates")
INVALID = _files(FIXTURES / "invalid")


def test_fixture_folders_are_not_empty():
    assert len(_files(FIXTURES / "valid")) >= 3 and len(INVALID) >= 20


@pytest.mark.parametrize("path", VALID, ids=lambda p: p.name)
def test_accepts_what_zod_accepts(path: Path):
    StrategySpecV1.model_validate_json(path.read_text())


@pytest.mark.parametrize("path", INVALID, ids=lambda p: p.name)
def test_rejects_what_zod_rejects(path: Path):
    with pytest.raises(ValidationError):
        StrategySpecV1.model_validate_json(path.read_text())


def test_round_trip_keeps_the_stored_shape():
    raw = (FIXTURES / "valid" / "all-paper-order-and-limit-fields.json").read_text()
    spec = StrategySpecV1.model_validate_json(raw)
    again = StrategySpecV1.model_validate(spec.model_dump(by_alias=True, exclude_none=True))
    assert again == spec


def test_generated_models_are_current():
    """Fails when the JSON Schema changed without scripts/generate-contracts.sh."""
    # Generate inside the backend: the formatter reads its line length from pyproject.toml.
    with tempfile.TemporaryDirectory(dir=BACKEND) as directory:
        output = Path(directory) / "strategy_spec_v1.py"
        subprocess.run([str(BACKEND / "scripts" / "generate-contracts.sh"), str(output)], check=True)
        checked_in = BACKEND / "src" / "ai_trading" / "contracts" / "strategy_spec_v1.py"
        assert output.read_text() == checked_in.read_text()
```

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_contracts.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.contracts.strategy_spec_v1'`.

- [ ] **Step 4: Write the base model** `ai-trading/backend/src/ai_trading/contracts/base.py`:

```python
"""Base class for the generated strategy-spec models (scripts/generate-contracts.sh).

Pydantic must reject exactly what the Zod schema in ai-trading/contracts rejects:
- strict mode: "20" is not 20;
- allow_inf_nan=False: JSON 1e400 parses to infinity, which Zod rejects;
- no nulls: Zod's .optional() allows a missing key, never null;
- no booleans: spec v1 has no boolean field, and Python's True == 1 would pass Literal[1].
  A v1 field that needs a boolean must change this rule (the parity test will fail first).
"""

from typing import Any

from pydantic import BaseModel, ConfigDict, model_validator


class SpecModel(BaseModel):
    model_config = ConfigDict(strict=True, allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def _reject_null_and_bool(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for key, value in data.items():
                if value is None or isinstance(value, bool):
                    raise ValueError(f"{key} must not be null or a boolean")
        return data
```

- [ ] **Step 5: Write the generator script** `ai-trading/backend/scripts/generate-contracts.sh`, then make it executable:

```sh
#!/bin/sh
# Regenerates the Pydantic models from ai-trading/contracts' JSON Schema.
# Usage: scripts/generate-contracts.sh [output-file]
set -eu
cd "$(dirname "$0")/.."
uv run datamodel-codegen \
  --input ../contracts/generated/strategy-spec-v1.schema.json \
  --input-file-type jsonschema \
  --output "${1:-src/ai_trading/contracts/strategy_spec_v1.py}" \
  --output-model-type pydantic_v2.BaseModel \
  --base-class ai_trading.contracts.base.SpecModel \
  --class-name StrategySpecV1 \
  --target-python-version 3.12 \
  --use-annotated \
  --field-constraints \
  --enum-field-as-literal all \
  --use-union-operator \
  --use-standard-collections \
  --collapse-root-models \
  --use-double-quotes \
  --disable-timestamp \
  --formatters builtin
```

Run: `chmod +x ai-trading/backend/scripts/generate-contracts.sh && ai-trading/backend/scripts/generate-contracts.sh`
Expected: `src/ai_trading/contracts/strategy_spec_v1.py` is written, with `class StrategySpecV1(SpecModel)` and classes such as `CompareCondition` and `PaperOrder`.

- [ ] **Step 6: Run the tests and lint.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_contracts.py && uv run ruff check . && uv run ruff format --check .`
Expected: `29 passed`, then two clean ruff runs.

- [ ] **Step 7: Commit.**

```bash
git add ai-trading/backend
git commit -m "feat(ai-trading): Desk backend scaffold with generated spec models"
```

### Task 1.3: Session calendar

**Files:**
- Create: `ai-trading/backend/src/ai_trading/core/calendar.py`, `ai-trading/backend/tests/bars.py`, `ai-trading/backend/tests/test_calendar.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ET`; `Asset = Literal["stock", "future"]`
  - `Session(day, extended_open, regular_open, regular_close, extended_close)`, with UTC `pd.Timestamp` fields
  - `session(asset, day) -> Session | None`; `previous_session(asset, day) -> date`; `et(day, "HH:MM") -> pd.Timestamp` (UTC)
  - `annotate(bars, asset) -> DataFrame`: adds `day` and `phase` (`pre`, `regular`, `post`) and drops bars outside every session
  - Test helpers in `tests/bars.py`: `trading_days`, `minute_bars`, `set_bar`, `daily_bars`

- [ ] **Step 1: Write the test helpers** `ai-trading/backend/tests/bars.py`:

```python
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
```

- [ ] **Step 2: Write the failing test** `ai-trading/backend/tests/test_calendar.py`:

```python
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
```

- [ ] **Step 3: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_calendar.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.calendar'`.

- [ ] **Step 4: Implement** `ai-trading/backend/src/ai_trading/core/calendar.py`:

```python
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
```

- [ ] **Step 5: Run the tests.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_calendar.py && uv run ruff check . && uv run ruff format --check .`
Expected: `7 passed`; ruff clean.

- [ ] **Step 6: Commit.**

```bash
git add ai-trading/backend/src/ai_trading/core/calendar.py ai-trading/backend/tests/bars.py ai-trading/backend/tests/test_calendar.py
git commit -m "feat(ai-trading): Desk session calendar for stocks and CME futures"
```

### Task 1.4: Indicators

**Files:**
- Create: `ai-trading/backend/src/ai_trading/core/indicators.py`, `ai-trading/backend/tests/test_indicators.py`

**Interfaces:**
- Consumes: `annotate`, `ET` (Task 1.3).
- Produces:
  - `sma(values, length)`, `ema(values, length)`, `rsi(close, length)`, `atr(bars, length)`: pandas Series in, Series out, NaN until there is enough history
  - `session_vwap(ann)`, `rvol_intraday(ann, lookback_days)`: aligned to an annotated 1-minute frame
  - `rvol_daily(daily, lookback_days)`

- [ ] **Step 1: Write the failing test** `ai-trading/backend/tests/test_indicators.py`:

```python
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
    # Wilder seeds with the first-period mean, not the first delta
    np.testing.assert_allclose(indicators.rsi(series(10, 11, 10, 10), 3), [np.nan, np.nan, np.nan, 50])


def test_atr_uses_the_previous_close():
    bars = pd.DataFrame({"high": [10.0, 12.0], "low": [9.0, 11.0], "close": [9.5, 11.5]})
    np.testing.assert_allclose(indicators.atr(bars, 1), [1.0, 2.5])
    # length 2: true ranges [1.0, 2.5, 1.0], seeded with the mean of the first two
    bars3 = pd.DataFrame({"high": [10.0, 12.0, 12.0], "low": [9.0, 11.0, 11.0], "close": [9.5, 11.5, 11.5]})
    np.testing.assert_allclose(indicators.atr(bars3, 2), [np.nan, 1.75, 1.375])


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


def test_wilder_seeds_after_length_valid_values():
    # an interior NaN must not count toward the seed window: the 3rd valid value is 5, not 3
    np.testing.assert_allclose(indicators._wilder(series(1, np.nan, 3, 5), 3), [np.nan, np.nan, np.nan, 3.0])
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_indicators.py`
Expected: collection error, `ImportError: cannot import name 'indicators'`.

- [ ] **Step 3: Implement** `ai-trading/backend/src/ai_trading/core/indicators.py`:

```python
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
```

- [ ] **Step 4: Run the tests.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_indicators.py && uv run ruff check . && uv run ruff format --check .`
Expected: `7 passed`; ruff clean.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/backend/src/ai_trading/core/indicators.py ai-trading/backend/tests/test_indicators.py
git commit -m "feat(ai-trading): Desk indicators (SMA, EMA, RSI, ATR, VWAP, relative volume)"
```

### Task 1.5: Levels

**Files:**
- Create: `ai-trading/backend/src/ai_trading/core/levels.py`, `ai-trading/backend/tests/test_levels.py`

**Interfaces:**
- Consumes: `session`, `previous_session`, `annotate` (Task 1.3).
- Produces:
  - `prior_day(daily, days, asset, column) -> Series` indexed by `days`
  - `n_day(daily, days, count, column) -> Series` indexed by `days`
  - `pre_phase(ann, side) -> Series` aligned to `ann`
  - `opening_range(ann, asset, minutes, side) -> Series` aligned to `ann`
  - `column` and `side` are `"high"`, `"low"`, or (prior day only) `"close"`.

- [ ] **Step 1: Write the failing test** `ai-trading/backend/tests/test_levels.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_levels.py`
Expected: collection error, `ImportError: cannot import name 'levels'`.

- [ ] **Step 3: Implement** `ai-trading/backend/src/ai_trading/core/levels.py`:

```python
"""Price levels. A level is NaN until the window that defines it has closed, so it never moves
while a rule is using it."""

import numpy as np
import pandas as pd

from ai_trading.core.calendar import Asset, previous_session, session


def prior_day(daily: pd.DataFrame, days: pd.Index, asset: Asset, column: str) -> pd.Series:
    """`column` ("high", "low", "close") of the trading day before each of `days`, from regular-
    session daily bars indexed by date. NaN when that day's bar is missing."""
    previous = [previous_session(asset, day) for day in days]
    return pd.Series(daily[column].reindex(previous).to_numpy(), index=days)


def n_day(daily: pd.DataFrame, days: pd.Index, count: int, column: str) -> pd.Series:
    """Highest high ("high") or lowest low ("low") of the `count` daily bars before each of
    `days`. NaN without `count` bars of history."""
    values = daily[column]
    window = values.rolling(count, min_periods=count)
    rolled = (window.max() if column == "high" else window.min()).to_numpy()
    last_before = values.index.searchsorted(days, side="left") - 1
    out = np.where(last_before >= 0, rolled[np.clip(last_before, 0, None)], np.nan)
    return pd.Series(out, index=days, dtype=float)


def pre_phase(ann: pd.DataFrame, side: str) -> pd.Series:
    """High ("high") or low ("low") of each day's pre phase (stock pre-market, futures overnight),
    known from the regular open on. Aligned to `ann`'s index."""
    pre = ann[ann["phase"] == "pre"]
    grouped = pre[side].groupby(pre["day"])
    per_day = grouped.max() if side == "high" else grouped.min()
    known = ann["phase"] != "pre"
    return pd.Series(ann["day"].map(per_day).to_numpy(), index=ann.index).where(known)


def opening_range(ann: pd.DataFrame, asset: Asset, minutes: int, side: str) -> pd.Series:
    """High or low of the first `minutes` of each regular session, known from the bar that
    starts when the range ends. NaN on days whose session is shorter than the range."""
    out = pd.Series(float("nan"), index=ann.index)
    for day, rows in ann.groupby("day").groups.items():
        found = session(asset, day)
        end = found.regular_open + pd.Timedelta(minutes=minutes)
        if end > found.regular_close:
            continue
        day_bars = ann.loc[rows]
        window = day_bars[(day_bars.index >= found.regular_open) & (day_bars.index < end)]
        if window.empty:
            continue
        value = window["high"].max() if side == "high" else window["low"].min()
        out.loc[day_bars.index[day_bars.index >= end]] = value
    return out
```

- [ ] **Step 4: Run the tests.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_levels.py && uv run ruff check . && uv run ruff format --check .`
Expected: `6 passed`; ruff clean.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/backend/src/ai_trading/core/levels.py ai-trading/backend/tests/test_levels.py
git commit -m "feat(ai-trading): Desk price levels"
```

### Task 1.6: Evaluator

**Files:**
- Create: `ai-trading/backend/src/ai_trading/core/evaluate.py`, `ai-trading/backend/tests/test_evaluate.py`

**Interfaces:**
- Consumes: Tasks 1.2–1.5.
- Produces (Phase 3's runtime relies on these):
  - `SignalCandidate(symbol: str, bar_time: pd.Timestamp, evidence: dict[str, float])`. `bar_time` is the UTC bar start for `bar_close_1m`, 08:30 ET for `premarket_0830`, and the session's regular close for `daily_close` and `weekly`. It is the dedupe key's bar time.
  - `check(spec) -> list[str]`: semantic problems the JSON Schema cannot express. The API returns these on save (Phase 3).
  - `evaluate(spec, symbol, asset, *, bars_1m, bars_1d, as_of) -> list[SignalCandidate]`: candidates for every evaluation point closed by `as_of`, oldest first. It raises `ValueError` when `check()` finds problems, or when an intraday cadence gets no 1-minute bars.
  - `label(operand) -> str`: the evidence key, for example `"opening_range_high(15)"`.

- [ ] **Step 1: Write the failing test** `ai-trading/backend/tests/test_evaluate.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_evaluate.py`
Expected: collection error, `ModuleNotFoundError: No module named 'ai_trading.core.evaluate'`.

- [ ] **Step 3: Implement** `ai-trading/backend/src/ai_trading/core/evaluate.py`:

```python
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
    """`evidence` holds only the operands known at `bar_time` (JSON/jsonb has no NaN)."""

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
    arg = next((operand[key] for key in ("length", "lookbackDays", "minutes", "days") if key in operand), None)
    return f"{name}({arg})" if arg is not None else name


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
    # crosses: now beyond, and the previous bar at or behind. A level or a constant that only
    # became known on this bar is compared with its current value, on either side; a series needs
    # its own known previous value, so it joins the known mask below instead of falling back.
    before_left = _before_cross(left, node["left"])
    before_right = _before_cross(right, node["right"])
    if op == "crosses_above":
        now, before = left > right, before_left <= before_right
    else:
        now, before = left < right, before_left >= before_right
    return _truth((now & before).to_numpy(), known & before_left.notna() & before_right.notna())


def _before_cross(value: pd.Series, operand: dict[str, Any]) -> pd.Series:
    """The previous bar's value for a crosses operand: a level or a constant that only became
    known on this bar falls back to its current value; a series needs its own known value."""
    shifted = value.shift(1)
    return shifted if "series" in operand else shifted.fillna(value)


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
    now = truth.reindex(rows)
    now.index = points.index
    if run_on == "premarket_0830":
        fired = now.fillna(False).astype(bool)
    else:
        # An unknown point neither fires nor resets the edge: compare with the last KNOWN state
        # before it (per day for bar_close_1m, the whole series for daily_close/weekly).
        groups = frame.days.to_series(index=frame.bars.index).reindex(rows).to_numpy()
        keys = groups if run_on == "bar_close_1m" else np.zeros(len(now))
        last_known = now.groupby(keys).transform(lambda s: s.ffill().shift(1))
        fired = now.fillna(False).astype(bool) & ~last_known.fillna(False).astype(bool)

    evidence = {label(op): _series(op, frame).reindex(rows).to_numpy() for op in _operands(when)}
    out = []
    for position in np.flatnonzero(fired.to_numpy()):
        values = {
            key: round(float(series[position]), 6) for key, series in evidence.items() if not np.isnan(series[position])
        }
        out.append(SignalCandidate(symbol, points.index[position], values))
    return out
```

- [ ] **Step 4: Run the tests.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_evaluate.py && uv run ruff check . && uv run ruff format --check .`
Expected: `17 passed`; ruff clean.

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/backend/src/ai_trading/core/evaluate.py ai-trading/backend/tests/test_evaluate.py
git commit -m "feat(ai-trading): closed-bar strategy evaluator with rising-edge signals"
```

### Task 1.7: Templates and golden tests

**Files:**
- Create: `ai-trading/contracts/templates/*.json` (10 files)
- Create: `ai-trading/backend/tests/test_templates.py`

**Interfaces:**
- Consumes: Tasks 1.1–1.6. Both earlier suites already validate every file in `templates/`.
- Produces: the template IDs (file stems) that Phase 3 seeds and Phase 4's builder lists: `orb-breakout`, `vwap-reclaim`, `vwap-loss`, `premarket-high-break`, `gap-and-go`, `futures-overnight-range-break`, `volume-spike`, `n-day-breakout`, `pullback-to-average`, `rsi-reversal`.

- [ ] **Step 1: Write the failing golden test** `ai-trading/backend/tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `cd ai-trading/backend && uv run pytest -q tests/test_templates.py`
Expected: `test_every_template_has_a_golden_case` fails (no templates yet), and the other cases fail with `FileNotFoundError`.

- [ ] **Step 3: Write the templates** in `ai-trading/contracts/templates/`.

`futures-overnight-range-break.json`:

```json
{
  "schemaVersion": 1,
  "name": "Futures overnight-range break",
  "watch": { "universe": { "symbols": ["/ES", "/NQ"] }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "any": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "overnight_high" } },
      { "op": "crosses_below", "left": { "series": "close" }, "right": { "level": "overnight_low" } }
    ]
  },
  "then": { "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" } },
  "limits": { "cooldownMinutes": 15 }
}
```

`gap-and-go.json`:

```json
{
  "schemaVersion": 1,
  "name": "Gap and go (08:30 scan)",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "extended", "runOn": "premarket_0830" },
  "when": {
    "all": [
      {
        "any": [
          { "op": "gte", "left": { "series": "gap_pct" }, "right": { "value": 3 } },
          { "op": "lte", "left": { "series": "gap_pct" }, "right": { "value": -3 } }
        ]
      },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 2 } }
    ]
  },
  "then": { "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" } }
}
```

`n-day-breakout.json`:

```json
{
  "schemaVersion": 1,
  "name": "20-day breakout on volume",
  "watch": { "universe": { "watchlist": "Swing" }, "session": "regular", "runOn": "daily_close" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "n_day_high", "days": 20 } },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 20 }, "right": { "value": 1.5 } }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 300 }, "stop": { "atrMultiple": 2 }, "target": { "r": 3 } }
  },
  "limits": { "maxOpenPositions": 3 }
}
```

`orb-breakout.json`:

```json
{
  "schemaVersion": 1,
  "name": "Opening-range breakout (15 min)",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "opening_range_high", "minutes": 15 } },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 2 } },
      { "op": "gt", "left": { "series": "close" }, "right": { "series": "vwap" } }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 200 }, "stop": { "level": "opening_range_low", "minutes": 15 }, "target": { "r": 2 } }
  },
  "limits": { "maxTradesPerDay": 3, "maxOpenPositions": 2, "flatBy": "15:55", "pauseAfterDailyLossUsd": 600 }
}
```

`premarket-high-break.json`:

```json
{
  "schemaVersion": 1,
  "name": "Pre-market high break",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "level": "premarket_high" } },
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 1.5 } },
      { "op": "time_between", "start": "09:30", "end": "11:00" }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 200 }, "stop": { "level": "premarket_low" }, "target": { "r": 2 } }
  },
  "limits": { "maxTradesPerDay": 2, "maxOpenPositions": 1, "flatBy": "15:55" }
}
```

`pullback-to-average.json`:

```json
{
  "schemaVersion": 1,
  "name": "Pullback to the 20/50-day average in an uptrend",
  "watch": { "universe": { "watchlist": "Swing" }, "session": "regular", "runOn": "daily_close" },
  "when": {
    "all": [
      { "op": "gt", "left": { "series": "sma", "length": 20 }, "right": { "series": "sma", "length": 50 } },
      {
        "any": [
          { "op": "within_pct", "left": { "series": "close" }, "right": { "series": "sma", "length": 20 }, "pct": 1 },
          { "op": "within_pct", "left": { "series": "close" }, "right": { "series": "sma", "length": 50 }, "pct": 1 }
        ]
      }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 300 }, "stop": { "atrMultiple": 2 }, "target": { "r": 2 } }
  },
  "limits": { "maxOpenPositions": 3 }
}
```

`rsi-reversal.json`:

```json
{
  "schemaVersion": 1,
  "name": "RSI oversold reversal",
  "watch": { "universe": { "watchlist": "Swing" }, "session": "regular", "runOn": "daily_close" },
  "when": { "op": "crosses_above", "left": { "series": "rsi", "length": 14 }, "right": { "value": 30 } },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 300 }, "stop": { "atrMultiple": 1.5 }, "target": { "r": 2 } }
  },
  "limits": { "maxOpenPositions": 3 }
}
```

`volume-spike.json`:

```json
{
  "schemaVersion": 1,
  "name": "Volume spike",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "gte", "left": { "series": "rvol", "lookbackDays": 10 }, "right": { "value": 3 } },
      { "op": "time_between", "start": "09:45", "end": "15:45" }
    ]
  },
  "then": { "alert": { "channels": ["inbox"], "severity": "info" } }
}
```

`vwap-loss.json`:

```json
{
  "schemaVersion": 1,
  "name": "VWAP loss",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_below", "left": { "series": "close" }, "right": { "series": "vwap" } },
      { "op": "time_between", "start": "09:45", "end": "15:30" }
    ]
  },
  "then": { "alert": { "channels": ["inbox", "telegram"], "severity": "risk" } },
  "limits": { "cooldownMinutes": 30 }
}
```

`vwap-reclaim.json`:

```json
{
  "schemaVersion": 1,
  "name": "VWAP reclaim",
  "watch": { "universe": { "watchlist": "Day movers" }, "session": "regular", "runOn": "bar_close_1m" },
  "when": {
    "all": [
      { "op": "crosses_above", "left": { "series": "close" }, "right": { "series": "vwap" } },
      { "op": "time_between", "start": "09:45", "end": "15:30" }
    ]
  },
  "then": {
    "alert": { "channels": ["inbox", "telegram"], "severity": "opportunity" },
    "paperOrder": { "side": "buy", "size": { "riskUsd": 200 }, "stop": { "atrMultiple": 2 }, "target": { "r": 2 } }
  },
  "limits": { "maxTradesPerDay": 2, "maxOpenPositions": 1, "flatBy": "15:55", "cooldownMinutes": 30 }
}
```

- [ ] **Step 4: Run every suite.**

Run: `cd ai-trading/backend && uv run pytest -q && uv run ruff check . && uv run ruff format --check .`
Expected: `107 passed` in about 15 seconds; ruff clean.

Run: `cd ai-trading/contracts && pnpm test`
Expected: `# pass 38`, `# fail 0` (the ten templates are now validated too).

- [ ] **Step 5: Commit.**

```bash
git add ai-trading/contracts/templates ai-trading/backend/tests/test_templates.py
git commit -m "feat(ai-trading): ten intraday and swing strategy templates with golden tests"
```

### Task 1.8: CI job and phase status

**Files:**
- Modify: `.github/workflows/ai-trading-ci.yml` (add the `desk` job after `hub`)
- Modify: `ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md` (Phase 1 row), `ai-trading/plans/STATUS.md` (the "5+" row)

**Interfaces:**
- Consumes: Tasks 1.1–1.7.
- Produces: a `Desk contracts and backend` check on every pull request that touches `ai-trading/`.

- [ ] **Step 1: Add the job** to `.github/workflows/ai-trading-ci.yml`, between the `hub` and `scripts` jobs:

```yaml
  desk:
    name: Desk contracts and backend
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: pnpm/action-setup@v4
        with:
          version: 11.9.0
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: ai-trading/contracts/pnpm-lock.yaml
      - uses: astral-sh/setup-uv@v10
        with:
          enable-cache: true
          cache-dependency-glob: ai-trading/backend/uv.lock
      - name: Contracts (Zod, fixtures, JSON Schema drift)
        working-directory: ai-trading/contracts
        run: |
          pnpm install --frozen-lockfile
          pnpm typecheck
          pnpm test
      - name: Backend (Pydantic parity and drift, core, templates)
        working-directory: ai-trading/backend
        run: |
          uv sync --locked
          uv run ruff check .
          uv run ruff format --check .
          uv run pytest -q
```

- [ ] **Step 2: Validate the workflow.**

Run: `actionlint .github/workflows/ai-trading-ci.yml` (install with `brew install actionlint` if missing)
Expected: no output.

- [ ] **Step 3: Mark Phase 1 done.**
  - In 02c's Phases table, set the Phase 1 row's task file to `[phase-1-strategy-core.md](02c-desk-v1-tasks/phase-1-strategy-core.md)` and its status to `Done`.
  - In `STATUS.md`, add to the "5+" row: "Phase 1 (strategy core) done: contracts package, backend core, ten templates with golden tests."

- [ ] **Step 4: Run the full verification.**

Run: `cd ai-trading/contracts && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test`
Run: `cd ai-trading/backend && uv sync --locked && uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
Expected: `# pass 38`, `107 passed`, everything else clean.

- [ ] **Step 5: Commit.**

```bash
git add .github/workflows/ai-trading-ci.yml ai-trading/plans/subplans/02c-desk-v1-implementation-plan.md ai-trading/plans/STATUS.md
git commit -m "ci(ai-trading): Desk contracts and backend job; mark Desk Phase 1 done"
```

## After the Tasks (main session)

1. Merge the subagent's branch into `feature/toby`, then remove its worktree and delete the branch.
2. Open **one** pull request from `feature/toby` to `dev` for the whole phase. The docs commits already on `feature/toby` ride along. Wait for the checks, then squash-merge (`gh pr checks <n> --watch`, then `gh pr merge <n> --squash`).
3. Phase 1 deploys nothing (02c "Delivery"), so there is no `main` release.
