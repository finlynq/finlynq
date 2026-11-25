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
export const HORIZON_CHOICES = [12, 24, 36, 60, 120] as const;

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
      /** "carried" = only months the budget carried past its horizon, counted from where carrying starts; "all" = every month, counted from the layer start. */
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

export const layerSchema = z.discriminatedUnion("kind", [budgetLayerSchema, growthLayerSchema, manualLayerSchema]);
export type ForecastLayer = z.infer<typeof layerSchema>;

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
        label: "Inflation on carried budgets",
        op: "grow",
        scope: { lineTypes: ["expense"] },
        params: { ratePct: null, appliesTo: "carried" },
      },
    ],
  });
}
