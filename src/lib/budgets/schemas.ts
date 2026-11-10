/** Zod shapes shared by the budget REST routes and MCP `manage_budgets`. */
import { z } from "zod";
import { MONTH_RE } from "./lines";

export const fillSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("budget") }),
  z.object({ kind: z.literal("spent") }),
  z.object({ kind: z.literal("average"), months: z.number().int().min(1).max(24) }),
  z.object({ kind: z.literal("same_month_last_year") }),
  z.object({ kind: z.literal("fixed"), amount: z.number().nonnegative() }),
]);

export const fillAdjustSchema = z.object({
  mode: z.enum(["percent", "amount"]),
  value: z.number(),
  every: z.enum(["once", "month", "year"]),
  stepMonth: z.number().int().min(1).max(12).optional(),
});

export const fillScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }),
  z.object({ kind: z.literal("keys"), keys: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("group"), group: z.string() }),
]);

export const fillBodySchema = z.object({
  months: z.array(z.string().regex(MONTH_RE, "months must be YYYY-MM")).min(1).max(36),
  source: fillSourceSchema,
  adjust: fillAdjustSchema.nullable().optional(),
  overwrite: z.boolean().default(false),
  scope: fillScopeSchema.default({ kind: "all" }),
  section: z.enum(["spending", "income"]).default("spending"),
  preview: z.boolean().default(true),
  /** Absent = one value per month (MCP, older clients). See FillMode in write.ts. */
  mode: z.enum(["values", "this_month", "rules"]).optional(),
  noEnd: z.boolean().optional(),
});

export const ruleIncreaseSchema = z.object({
  mode: z.enum(["percent", "amount"]),
  value: z.number().finite(),
  every: z.enum(["month", "year"]),
  stepMonth: z.number().int().min(1).max(12).optional(),
});

/** A budget rule's fields (plan/budget-rules.md). */
export const ruleInputSchema = z
  .object({
    amount: z.number().finite().nonnegative().max(1e12),
    startMonth: z.string().regex(MONTH_RE, "startMonth must be YYYY-MM"),
    endMonth: z.string().regex(MONTH_RE, "endMonth must be YYYY-MM").nullable().optional(),
    increase: ruleIncreaseSchema.nullable().optional(),
  })
  .refine((r) => !r.endMonth || r.endMonth >= r.startMonth, { message: "The end month is before the start month.", path: ["endMonth"] });
