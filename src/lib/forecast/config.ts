/**
 * Forecast scenario settings (plan/forecast-scenarios.md, Phase 1). Pure,
 * client-safe: the page re-runs the engine in the browser on every change.
 *
 * A scenario = horizon + assumptions + an ORDERED list of layers. For every
 * line and month the plan stage folds the enabled layers top to bottom
 * (layers.ts). Phase 1 implements three layer kinds (budget, growth, manual);
 * history / budget_realism / scheduled / events arrive in later phases, as
 * new enum values (bump `schemaVersion` only if an existing field changes
 * meaning).
 */
import { z } from "zod";

/** Bumped whenever the engine's arithmetic changes in a way that moves numbers. */
export const FORECAST_ENGINE_VERSION = 1;
/** Bumped whenever ForecastResult's shape changes (snapshots are read through an upgrade). */
export const FORECAST_RESULT_SCHEMA_VERSION = 1;
export const FORECAST_CONFIG_SCHEMA_VERSION = 1;

/** Longest horizon the engine accepts (50 years, monthly). */
export const MAX_HORIZON_MONTHS = 600;
export const HORIZON_CHOICES = [12, 24, 36, 60, 120, 240, 360, 480, 600] as const;

export const LINE_TYPES = ["income", "expense", "debt"] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const COMBINE_OPS = ["fill", "set", "add", "scale", "floor", "cap", "grow"] as const;
export type CombineOp = (typeof COMBINE_OPS)[number];

const monthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM.");

/** Which lines a layer touches. Empty / omitted = every line it can touch. */
export const layerScopeSchema = z
  .object({
    lineTypes: z.array(z.enum(["income", "expense"])).max(2).optional(),
    lineKeys: z.array(z.string().max(80)).max(500).optional(),
    groups: z.array(z.string().max(120)).max(100).optional(),
  })
  .default({});
export type LayerScope = z.infer<typeof layerScopeSchema>;

const layerBase = {
  id: z.string().min(1).max(40),
  label: z.string().max(120).default(""),
  enabled: z.boolean().default(true),
  scope: layerScopeSchema,
  from: monthStr.optional(),
  to: monthStr.optional(),
  note: z.string().max(500).optional(),
  updatedBy: z.enum(["user", "assistant"]).default("user"),
};

/** The user's budget: stored months, budget rules for any month, and (option) the last budget carried past the 36-month budget horizon. */
export const budgetLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("budget"),
  op: z.enum(["fill", "set"]).default("fill"),
  params: z.object({ carryForwardBeyondHorizon: z.boolean().default(true) }).default({ carryForwardBeyondHorizon: true }),
});

/** Grows the value so far by a yearly rate. `ratePct: null` = the scenario's inflation. */
export const growthLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("growth"),
  op: z.literal("grow").default("grow"),
  params: z
    .object({
      ratePct: z.number().min(-50).max(100).nullable().default(null),
      /** "carried" = budgets carried past the budget horizon (from where carrying starts) and amounts from history (from the forecast start); budgets you set are never grown. "all" = every month, counted from the layer start. */
      appliesTo: z.enum(["carried", "all"]).default("carried"),
    })
    .default({ ratePct: null, appliesTo: "carried" }),
});

/** An explicit amount (set / add / floor / cap) or factor (scale) for the scoped lines and months. */
export const manualLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("manual"),
  op: z.enum(["set", "add", "scale", "floor", "cap", "fill"]),
  params: z.object({ amount: z.number().min(-1e12).max(1e12) }),
});

/** Your own past amounts per line (complete months before the forecast starts). A line with no history stays blank. */
export const historyLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("history"),
  op: z.enum(["fill", "set", "floor"]).default("fill"),
  params: z
    .object({
      lookbackMonths: z.number().int().min(1).max(24).default(6),
      method: z.enum(["average", "median"]).default("average"),
      /** Use the same calendar month(s) within the lookback when there are any (needs a lookback of 12+). */
      seasonal: z.boolean().default(false),
    })
    .default({ lookbackMonths: 6, method: "average", seasonal: false }),
});

/** Scales the value so far by what you actually spent (or received) against your budget in recent months. */
export const budgetRealismLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("budget_realism"),
  op: z.literal("scale").default("scale"),
  params: z
    .object({
      lookbackMonths: z.number().int().min(1).max(24).default(6),
      /** Months with a budget needed before the ratio is used. */
      minMonths: z.number().int().min(1).max(24).default(2),
    })
    .default({ lookbackMonths: 6, minMonths: 2 }),
});

/** Subscriptions and recurring payments on their real dates (quarterly and yearly ones land in their months). */
export const scheduledLayerSchema = z.object({
  ...layerBase,
  kind: z.literal("scheduled"),
  op: z.enum(["floor", "fill", "add", "set"]).default("floor"),
  params: z.object({}).default({}),
});

export const layerSchema = z.discriminatedUnion("kind", [
  budgetLayerSchema,
  growthLayerSchema,
  manualLayerSchema,
  historyLayerSchema,
  budgetRealismLayerSchema,
  scheduledLayerSchema,
]);
export const LAYER_KINDS = ["budget", "history", "budget_realism", "scheduled", "growth", "manual"] as const;
export type LayerKind = (typeof LAYER_KINDS)[number];
export type ForecastLayer = z.infer<typeof layerSchema>;

// ── Events (Phase 3, plan section 6) ───────────────────────────────────────
//
// Named, dated changes. They are data: events.ts expands them into extra
// lines, layers and simulate-stage changes at run time, so they stay readable
// ("Buy a home, Jun 2028") instead of a pile of manual rows.

const eventBase = {
  id: z.string().min(1).max(40),
  label: z.string().max(120).default(""),
  enabled: z.boolean().default(true),
  /** First month the event applies. */
  month: monthStr,
  note: z.string().max(500).optional(),
  updatedBy: z.enum(["user", "assistant"]).default("user"),
};
const money = z.number().min(0).max(1e12);
const lineKey = z.string().max(80);
const debtKey = z.string().regex(/^(debt:\d+|newloan:[A-Za-z0-9_-]+)$/, "Pick a loan.");

/** A single amount in or out of cash (inheritance, wedding, car bought cash). */
export const oneOffEventSchema = z.object({
  ...eventBase,
  kind: z.literal("one_off"),
  params: z.object({ direction: z.enum(["in", "out"]), amount: money }),
});

/** A new monthly income or expense line from `month` to `to` (side income, childcare, a car's running costs). */
export const recurringItemEventSchema = z.object({
  ...eventBase,
  kind: z.literal("recurring_item"),
  params: z.object({
    type: z.enum(["income", "expense"]),
    amount: money,
    to: monthStr.optional(),
    /** Yearly growth; null = the scenario's inflation; 0 = flat. */
    growthPct: z.number().min(-50).max(100).nullable().default(0),
  }),
});

/** A raise, pay cut or job loss on income lines (empty = all income), from `month` to `to`. */
export const incomeChangeEventSchema = z.object({
  ...eventBase,
  kind: z.literal("income_change"),
  params: z.object({
    lineKeys: z.array(lineKey).max(200).default([]),
    op: z.enum(["scale", "set"]),
    /** Factor for scale (1.05 = +5%), amount per month for set (0 = no income). */
    value: z.number().min(0).max(1e12),
    to: monthStr.optional(),
  }),
});

/** Move cash into investments (or back), once or every month. */
export const moveMoneyEventSchema = z.object({
  ...eventBase,
  kind: z.literal("move_money"),
  params: z.object({
    direction: z.enum(["to_investments", "from_investments"]),
    amount: money,
    frequency: z.enum(["once", "monthly"]).default("monthly"),
    to: monthStr.optional(),
  }),
});

/** Pay more on one loan, once or every month. */
export const extraDebtPaymentEventSchema = z.object({
  ...eventBase,
  kind: z.literal("extra_debt_payment"),
  params: z.object({
    loanKey: debtKey,
    amount: money,
    frequency: z.enum(["once", "monthly"]).default("monthly"),
    to: monthStr.optional(),
  }),
});

/** A new loan taken in the scenario (never touches your real loans). */
export const newLoanEventSchema = z.object({
  ...eventBase,
  kind: z.literal("new_loan"),
  params: z.object({
    principal: money,
    annualRatePct: z.number().min(0).max(100),
    termMonths: z.number().int().min(1).max(600),
    /** Whether the money lands in cash (a personal loan) or is spent at once (a car loan for a car). */
    cashIn: z.boolean().default(true),
  }),
});

/** New rate and term for one of your loans from `month` (a scenario copy; the real loan is unchanged). */
export const refinanceEventSchema = z.object({
  ...eventBase,
  kind: z.literal("refinance"),
  params: z.object({
    loanKey: debtKey,
    annualRatePct: z.number().min(0).max(100),
    termMonths: z.number().int().min(1).max(600),
  }),
});

/** Buy a home: down payment from cash, a mortgage, the home as an asset, yearly costs, rent lines stopping. */
export const buyHomeEventSchema = z.object({
  ...eventBase,
  kind: z.literal("buy_home"),
  params: z.object({
    price: money,
    downPayment: money,
    mortgageRatePct: z.number().min(0).max(100),
    mortgageTermMonths: z.number().int().min(1).max(600),
    /** Property tax, insurance and upkeep, % of the price per year (grows with inflation). */
    yearlyCostsPct: z.number().min(0).max(20).default(1.5),
    /** Lines that stop from the purchase month (usually rent). */
    stopLineKeys: z.array(lineKey).max(50).default([]),
  }),
});

/** Throw an extra amount at debt every month, ordered snowball (smallest balance first) or avalanche (highest rate first); paid-off payments roll into it. */
export const debtStrategyEventSchema = z.object({
  ...eventBase,
  kind: z.literal("debt_strategy"),
  params: z.object({
    method: z.enum(["snowball", "avalanche"]),
    extraPerMonth: money,
  }),
});

export const eventSchema = z.discriminatedUnion("kind", [
  oneOffEventSchema,
  recurringItemEventSchema,
  incomeChangeEventSchema,
  moveMoneyEventSchema,
  extraDebtPaymentEventSchema,
  newLoanEventSchema,
  refinanceEventSchema,
  buyHomeEventSchema,
  debtStrategyEventSchema,
]);
export type ForecastEvent = z.infer<typeof eventSchema>;
export const EVENT_KINDS = [
  "one_off", "recurring_item", "income_change", "move_money", "extra_debt_payment",
  "new_loan", "refinance", "buy_home", "debt_strategy",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const assumptionsSchema = z.object({
  inflationPct: z.number().min(-20).max(50).default(2.5),
  investmentReturnPct: z.number().min(-50).max(50).default(5),
  otherAssetGrowthPct: z.number().min(-50).max(50).default(0),
});
export type ForecastAssumptions = z.infer<typeof assumptionsSchema>;

export const scenarioConfigSchema = z.object({
  schemaVersion: z.literal(FORECAST_CONFIG_SCHEMA_VERSION).default(FORECAST_CONFIG_SCHEMA_VERSION),
  horizonMonths: z.number().int().min(1).max(MAX_HORIZON_MONTHS).default(60),
  assumptions: assumptionsSchema.default({ inflationPct: 2.5, investmentReturnPct: 5, otherAssetGrowthPct: 0 }),
  /** When cash would go below zero: let it (and warn), or sell investments to cover it. */
  shortfall: z.enum(["negative", "draw_investments"]).default("negative"),
  layers: z.array(layerSchema).max(50).default([]),
  events: z.array(eventSchema).max(50).default([]),
});
export type ScenarioConfig = z.infer<typeof scenarioConfigSchema>;

/** The built-in Baseline: your budget, plus inflation on budgets carried past the budget horizon. */
export function baselineScenario(horizonMonths = 60): ScenarioConfig {
  return scenarioConfigSchema.parse({
    horizonMonths,
    layers: [
      {
        id: "budget",
        kind: "budget",
        label: "Budget",
        op: "fill",
        params: { carryForwardBeyondHorizon: true },
      },
      {
        id: "inflation",
        kind: "growth",
        label: "Inflation",
        op: "grow",
        scope: { lineTypes: ["expense"] },
        params: { ratePct: null, appliesTo: "carried" },
      },
    ],
  });
}


// ── Stored scenarios (Phase 2) ────────────────────────────────────────────

/**
 * A stored scenario is either a full config ("base") or a VARIANT that stores
 * only its differences from a parent (another stored scenario, or the
 * built-in Baseline). A parent's later changes flow into its variants.
 * Resolution and diffing are pure (variants.ts).
 */
export const variantPatchSchema = z.object({
  horizonMonths: z.number().int().min(1).max(MAX_HORIZON_MONTHS).optional(),
  // Explicit optional fields: assumptionsSchema.partial() would keep its defaults
  // and silently pin every assumption in the patch.
  assumptions: z
    .object({
      inflationPct: z.number().min(-20).max(50).optional(),
      investmentReturnPct: z.number().min(-50).max(50).optional(),
      otherAssetGrowthPct: z.number().min(-50).max(50).optional(),
    })
    .optional(),
  shortfall: z.enum(["negative", "draw_investments"]).optional(),
  /** Parent layers replaced in this variant (whole layer, by id). */
  layerOverrides: z.record(z.string(), layerSchema).default({}),
  removedLayerIds: z.array(z.string()).max(50).default([]),
  addedLayers: z.array(layerSchema).max(50).default([]),
  /** Final layer order by id, when it differs from parent order + added. */
  order: z.array(z.string()).max(100).optional(),
  /** Events, the same way as layers (Phase 3). */
  eventOverrides: z.record(z.string(), eventSchema).default({}),
  removedEventIds: z.array(z.string()).max(50).default([]),
  addedEvents: z.array(eventSchema).max(50).default([]),
});
export type VariantPatch = z.infer<typeof variantPatchSchema>;

export const scenarioParentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("builtin") }),
  z.object({ type: z.literal("scenario"), id: z.number().int().positive() }),
]);
export type ScenarioParent = z.infer<typeof scenarioParentSchema>;

export const scenarioDocSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("base"), config: scenarioConfigSchema }),
  z.object({ kind: z.literal("variant"), parent: scenarioParentSchema, patch: variantPatchSchema }),
]);
export type ScenarioDoc = z.infer<typeof scenarioDocSchema>;
