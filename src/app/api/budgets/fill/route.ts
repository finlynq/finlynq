/**
 * POST /api/budgets/fill — fill budgets for one or more months from a source
 * (a month's budget or spending, an average, the same month last year, or a
 * fixed amount) with an optional increase applied once, every month or every
 * year. `preview: true` (the default) returns the rows without saving.
 * Shared with MCP `manage_budgets(op: "fill")` via `runBudgetFill`.
 */
import { apiHandler } from "@/lib/api-handler";
import { fillBodySchema } from "@/lib/budgets/schemas";
import { runBudgetFill } from "@/lib/budgets/write";
import { budgetMapError } from "@/lib/budgets/api-errors";

export const POST = apiHandler({ auth: "auth", body: fillBodySchema, mapError: budgetMapError }, async ({ userId, dek, body }) =>
  runBudgetFill(userId, dek, body),
);
