/**
 * Budget rules (plan/budget-rules.md): an amount from a start month to an
 * optional end month, with an optional increase every month or every year.
 *
 *   GET    ?key=c:<id>|g:<group>&month=YYYY-MM  a line's rules + its next 12 months
 *   POST   { key, amount, startMonth, endMonth?, increase? }
 *   PUT    { id, amount, startMonth, endMonth?, increase? }   (every field)
 *   DELETE ?id=<rule id>
 *
 * Every write rewrites only the current and later months; months that have
 * ended keep their budgets. Amounts are in the display currency.
 */
import { z } from "zod";
import { apiHandler } from "@/lib/api-handler";
import { apiError } from "@/lib/api-response";
import { MONTH_RE } from "@/lib/budgets/lines";
import { ruleInputSchema } from "@/lib/budgets/schemas";
import { createBudgetRule, deleteBudgetRule, loadLineRulesView, updateBudgetRule } from "@/lib/budgets/rule-store";
import { budgetMapError } from "@/lib/budgets/api-errors";

export const GET = apiHandler({ auth: "auth", mapError: budgetMapError }, async ({ userId, request }) => {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") ?? "";
  const month = url.searchParams.get("month") ?? "";
  if (!key || !MONTH_RE.test(month)) return apiError("key and month (YYYY-MM) are required", 400);
  return loadLineRulesView(userId, key, month);
});

const createBody = z.intersection(z.object({ key: z.string().min(3) }), ruleInputSchema);

export const POST = apiHandler({ auth: "auth", body: createBody, mapError: budgetMapError }, async ({ userId, body }) => {
  const { key, ...input } = body;
  return createBudgetRule(userId, key, input);
});

const updateBody = z.intersection(z.object({ id: z.number().int().positive() }), ruleInputSchema);

export const PUT = apiHandler({ auth: "auth", body: updateBody, mapError: budgetMapError }, async ({ userId, body }) => {
  const { id, ...input } = body;
  await updateBudgetRule(userId, id, input);
  return { id };
});

export const DELETE = apiHandler({ auth: "auth", mapError: budgetMapError }, async ({ userId, request }) => {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return apiError("id is required", 400);
  await deleteBudgetRule(userId, id);
  return { id };
});
