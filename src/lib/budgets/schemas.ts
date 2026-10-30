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
});
