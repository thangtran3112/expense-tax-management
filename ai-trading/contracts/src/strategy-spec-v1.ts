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
