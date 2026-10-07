/**
 * The category-type vocabulary: `E` expense, `I` income, `R` transfer /
 * reconciliation. Pure + client-safe.
 *
 * Every report filters on these literal codes (`type === "E"`), so a category
 * stored under any other spelling silently drops its transactions out of the
 * income/expense totals. That happened: `POST /api/budgets/seed` (the
 * onboarding budgets step) created categories with `type: "expense"`, and
 * `POST`/`PUT /api/categories` validated `type` as a bare `z.string()`, so
 * nothing stopped it. `categories_type_check` now pins the column in SQL; this
 * module is the application-side half of the same rule.
 */
import { z } from "zod";

export const CATEGORY_TYPES = ["E", "I", "R"] as const;
export type CategoryType = (typeof CATEGORY_TYPES)[number];

/**
 * Spellings API/MCP callers plausibly send, mapped to the stored code (keys
 * are lowercase). Keep in lockstep with the normalizing UPDATEs in
 * `scripts/migrations/20261007_categories_type_check.sql`; the test in
 * `tests/category-type.test.ts` fails if they drift.
 */
export const CATEGORY_TYPE_ALIASES: Readonly<Record<string, CategoryType>> = {
  e: "E",
  expense: "E",
  expenses: "E",
  i: "I",
  income: "I",
  r: "R",
  t: "R",
  transfer: "R",
  transfers: "R",
  reconciliation: "R",
};

/** The stored code for `raw`, or null when it isn't a recognisable type. */
export function normalizeCategoryType(raw: unknown): CategoryType | null {
  if (typeof raw !== "string") return null;
  return CATEGORY_TYPE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * Request-body field: accepts the codes and the word forms above, yields the
 * code, and rejects anything else with a 400 rather than storing it.
 */
export const categoryTypeSchema = z.string().transform((raw, ctx) => {
  const type = normalizeCategoryType(raw);
  if (!type) {
    ctx.addIssue({
      code: "custom",
      message: `Invalid category type "${raw}". Use E (expense), I (income) or R (transfer).`,
    });
    return z.NEVER;
  }
  return type;
});
